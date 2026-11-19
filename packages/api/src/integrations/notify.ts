/**
 * Outgoing chat notifications (Slack, Microsoft Teams incoming webhooks).
 *
 * Called from the central webhook dispatch point (services/webhooks.ts deliverWebhook) and from the release endpoint.
 * Delivery uses the shared transport (plugins/transport.ts: no redirects, timeout, bounded retries with back-off),
 * the URL is checked against the SSRF guard both when it is saved and again right before sending, it is stored
 * encrypted, every attempt is logged, and each channel is rate limited so an event storm cannot flood a chat room.
 * Internal service-desk comments are never forwarded.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { decryptSecret } from '../auth/secrets';
import { assertPublicUrl } from '../plugins/ssrf';
import { postSigned } from '../plugins/transport';
import { isAllowed } from '../middleware/rate-limit';
import { disabledFeatures } from '../features';
import { buildChatMessage, chatEventFor, formatSlack, formatTeams, TEST_MESSAGE, type ChatMessage, type TeamsFormat } from './chat';

export const FEATURE_ID = 'integrations';

type Channel = typeof schema.notificationChannels.$inferSelect;

let fetchOverride: typeof fetch | null = null;
/** Tests inject a fake fetch here; null restores the global fetch. */
export function setNotifyFetch(f: typeof fetch | null) { fetchOverride = f; }

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const cfg = () => ({
  timeoutMs: num('NOTIFY_TIMEOUT_MS', 10_000),
  retryBaseMs: num('NOTIFY_RETRY_BASE_MS', 1000),
  maxAttempts: Math.max(1, num('NOTIFY_MAX_ATTEMPTS', 3)),
  perMinute: Math.max(1, num('NOTIFY_RATE_PER_MINUTE', 30)),
  failureThreshold: Math.max(1, num('NOTIFY_FAILURE_THRESHOLD', 20)),
  keepDeliveries: 100,
});

const pending = new Set<Promise<void>>();
/** Await all in-flight chat deliveries (tests, graceful shutdown). */
export async function flushChatNotifications(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** True when the integrations feature is on for the instance and (when given) the project. */
export async function integrationsEnabled(projectId: number | null): Promise<boolean> {
  if ((await disabledFeatures()).has(FEATURE_ID)) return false;
  if (projectId === null) return true;
  const [p] = await db.select({ off: schema.projects.disabledFeatures }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return !(p?.off ?? []).includes(FEATURE_ID);
}

export function dispatchChatNotification(event: string, payload: Record<string, any>): void {
  const p = run(event, payload).catch((e) => console.error('[chat-notify] dispatch failed:', e instanceof Error ? e.name : 'error'));
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

async function run(event: string, payload: Record<string, any>): Promise<void> {
  const chatEvent = chatEventFor(event, payload);
  if (!chatEvent) return;
  const projectId: number | null = payload.projectId ?? payload.project?.id ?? null;

  const channels = await db.select().from(schema.notificationChannels).where(and(
    eq(schema.notificationChannels.enabled, true),
    projectId === null ? isNull(schema.notificationChannels.projectId) : or(isNull(schema.notificationChannels.projectId), eq(schema.notificationChannels.projectId, projectId)),
  ));
  const targets = channels.filter((c) => (c.events ?? []).includes(chatEvent));
  if (!targets.length) return;
  if (!(await integrationsEnabled(projectId))) return;

  if (chatEvent === 'comment.added') {
    if (!payload.commentId) return;
    const [cm] = await db.select({ internal: schema.comments.isInternal }).from(schema.comments).where(eq(schema.comments.id, payload.commentId)).limit(1);
    if (!cm || cm.internal) return;
  }
  const msg = buildChatMessage(chatEvent, payload);
  await Promise.all(targets.map((ch) => deliverToChannel(ch, msg, chatEvent)));
}

export function renderForChannel(ch: Pick<Channel, 'type' | 'settings'>, msg: ChatMessage): Record<string, unknown> {
  if (ch.type === 'slack') return formatSlack(msg);
  const fmt = (ch.settings as { teamsFormat?: string } | null)?.teamsFormat;
  return formatTeams(msg, (fmt === 'messagecard' ? 'messagecard' : 'adaptive') as TeamsFormat);
}

export interface ChannelResult { ok: boolean; status: number | null; error: string | null; attempts: number; rateLimited?: boolean }

export async function deliverToChannel(ch: Channel, msg: ChatMessage, eventName: string): Promise<ChannelResult> {
  const c = cfg();
  const started = Date.now();
  let result: ChannelResult = { ok: false, status: null, error: null, attempts: 0 };
  try {
    const limit = await isAllowed(`veqsio:ratelimit:notify:${ch.id}`, { maxRequests: c.perMinute, windowMs: 60_000 });
    if (!limit.allowed) {
      result = { ok: false, status: null, error: `Rate limited (more than ${c.perMinute} messages per minute)`, attempts: 0, rateLimited: true };
    } else {
      const url = (await assertPublicUrl(decryptSecret(ch.urlEnc))).toString(); // re-checked on every send: DNS may have changed
      const r = await postSigned({
        url, event: eventName, deliveryId: crypto.randomUUID(), body: JSON.stringify(renderForChannel(ch, msg)),
        userAgent: 'Veqsio-Notifier/1.0', timeoutMs: c.timeoutMs, maxAttempts: c.maxAttempts, retryBaseMs: c.retryBaseMs,
        fetchImpl: fetchOverride ?? undefined,
      });
      result = r;
    }
  } catch (e) {
    result = { ok: false, status: null, error: e instanceof Error ? e.message.slice(0, 300) : 'delivery failed', attempts: result.attempts };
  }

  await db.insert(schema.notificationDeliveries).values({
    channelId: ch.id, event: eventName, status: result.ok ? 'success' : result.rateLimited ? 'rate_limited' : 'failed',
    responseStatus: result.status, error: result.ok ? null : result.error, attempts: Math.max(1, result.attempts), latencyMs: Date.now() - started,
  });
  // Keep the log short.
  await db.execute(sql`delete from notification_deliveries where channel_id = ${ch.id} and id not in (select id from notification_deliveries where channel_id = ${ch.id} order by id desc limit ${c.keepDeliveries})`);

  if (result.rateLimited) return result;
  if (result.ok) {
    if (ch.consecutiveFailures > 0) await db.update(schema.notificationChannels).set({ consecutiveFailures: 0 }).where(eq(schema.notificationChannels.id, ch.id));
  } else if (eventName !== 'test') {
    const [row] = await db.update(schema.notificationChannels)
      .set({ consecutiveFailures: sql`${schema.notificationChannels.consecutiveFailures} + 1` })
      .where(eq(schema.notificationChannels.id, ch.id)).returning({ n: schema.notificationChannels.consecutiveFailures });
    if (row && row.n >= c.failureThreshold) {
      await db.update(schema.notificationChannels).set({ enabled: false }).where(eq(schema.notificationChannels.id, ch.id));
    }
  }
  return result;
}

/** The "send test message" button. Not subject to the event filter; failures do not count towards auto-disable. */
export function sendTestMessage(ch: Channel): Promise<ChannelResult> {
  return deliverToChannel(ch, TEST_MESSAGE, 'test');
}
