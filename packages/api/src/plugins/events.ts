/**
 * Event delivery to plugins. Called from the existing webhook dispatch point (services/webhooks.ts deliverWebhook).
 * Payloads are deliberately lightweight (ids, keys, type, actor name): plugins fetch details with their token,
 * so what they see is governed by their service user's permissions and granted scopes.
 * Internal service-desk comments never trigger an event and their bodies are never included.
 */
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { decryptSecret } from '../auth/secrets';
import { scopeForEvent, scopeSatisfies, type PluginManifest } from './manifest';
import { postSigned } from './transport';
import { assertPublicUrl } from './ssrf';

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const cfg = () => ({
  timeoutMs: num('PLUGINS_DELIVERY_TIMEOUT_MS', 10_000),
  retryBaseMs: num('PLUGINS_RETRY_BASE_MS', 1000),
  maxAttempts: Math.max(1, num('PLUGINS_MAX_ATTEMPTS', 3)),
  failureThreshold: Math.max(1, num('PLUGINS_FAILURE_THRESHOLD', 20)),
});

const pending = new Set<Promise<void>>();
/** Await all in-flight plugin deliveries (used by tests and graceful shutdown). */
export async function flushPluginDeliveries(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Reduce a webhook payload to the whitelisted lightweight fields. */
export function buildPluginPayload(event: string, p: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pick = (k: string, from = k) => { if (p[from] !== undefined && p[from] !== null) out[k] = p[from]; };
  pick('issueId'); pick('issueKey'); pick('projectId'); pick('commentId'); pick('slaId'); pick('sprintId'); pick('boardId');
  if (typeof p.authorName === 'string') out.actor = { displayName: p.authorName };
  if (Array.isArray(p.changes)) out.changedFields = p.changes.map((c: any) => String(c?.field)).slice(0, 50);
  out.type = event;
  return out;
}

export function dispatchPluginEvent(event: string, payload: Record<string, any>): void {
  const p = run(event, payload).catch((e) => console.error('[plugins] dispatch failed:', e instanceof Error ? e.message : 'error'));
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

async function run(event: string, payload: Record<string, any>): Promise<void> {
  const rows = await db.select().from(schema.plugins).where(eq(schema.plugins.enabled, true));
  const targets = rows.filter((pl) => {
    const m = pl.manifest as PluginManifest;
    return m.events?.includes(event) && scopeSatisfies((pl.grantedScopes as string[]) ?? [], scopeForEvent(event));
  });
  if (targets.length === 0) return;

  if (event === 'comment.added' && payload.commentId) {
    const [c] = await db.select({ internal: schema.comments.isInternal }).from(schema.comments).where(eq(schema.comments.id, payload.commentId)).limit(1);
    if (!c || c.internal) return;
  }
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), payload: buildPluginPayload(event, payload) });
  await Promise.all(targets.map((pl) => deliverToPlugin(pl, event, body)));
}

export async function deliverToPlugin(pl: typeof schema.plugins.$inferSelect, event: string, body: string): Promise<void> {
  const c = cfg();
  const manifest = pl.manifest as PluginManifest;
  const deliveryId = crypto.randomUUID();
  const started = Date.now();
  let attempts = 0;
  let status: number | null = null;
  let error: string | null = null;
  let ok = false;

  try {
    if (!pl.signingSecretEnc) throw new Error('Plugin has no signing secret');
    const secret = decryptSecret(pl.signingSecretEnc);
    const url = (await assertPublicUrl(manifest.baseUrl.replace(/\/+$/, '') + (manifest.webhookPath ?? '/'))).toString();
    ({ ok, status, error, attempts } = await postSigned({
      url, secret, event, deliveryId, body, userAgent: 'Veqsio-Plugin/1.0',
      timeoutMs: c.timeoutMs, maxAttempts: c.maxAttempts, retryBaseMs: c.retryBaseMs,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 300) : 'delivery failed';
  }

  await db.insert(schema.pluginDeliveries).values({
    pluginId: pl.id, deliveryId, event, status: ok ? 'success' : 'failed',
    responseStatus: status, error: ok ? null : error, attempts, latencyMs: Date.now() - started,
  });

  if (ok) {
    if (pl.consecutiveFailures > 0) await db.update(schema.plugins).set({ consecutiveFailures: 0 }).where(eq(schema.plugins.id, pl.id));
    return;
  }
  // Circuit breaker: count consecutive failed deliveries atomically; trip at the threshold.
  const [row] = await db.update(schema.plugins)
    .set({ consecutiveFailures: sql`${schema.plugins.consecutiveFailures} + 1` })
    .where(eq(schema.plugins.id, pl.id))
    .returning({ n: schema.plugins.consecutiveFailures });
  if (row && row.n >= c.failureThreshold) {
    await db.update(schema.plugins)
      .set({ enabled: false, updatedAt: new Date(), disabledReason: `Disabled automatically after ${row.n} consecutive failed deliveries (last error: ${error ?? 'unknown'})` })
      .where(and(eq(schema.plugins.id, pl.id), eq(schema.plugins.enabled, true)));
  }
}
