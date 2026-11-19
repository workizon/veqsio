/**
 * Integrations: inbound webhook sources (public ingestion endpoint + per-project administration) and outgoing
 * Slack / Microsoft Teams notification channels (per project and instance default).
 * Feature switch id: `integrations` (instance wide and per project).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { requireGlobalPermission } from '../rbac/middleware';
import { decryptSecret, encryptSecret, secretsConfigured } from '../auth/secrets';
import { assertPublicUrl } from '../plugins/ssrf';
import { getClientIP, isAllowed } from '../middleware/rate-limit';
import { mappingSchema } from '../integrations/mapping';
import { providedSecret, headerIdempotencyKey, safeEqual, verifyHmac } from '../integrations/verify';
import { SENTRY_SIGNATURE_HEADER } from '../integrations/sentry';
import { dryRun, receive, type Source } from '../integrations/inbound';
import { CHAT_EVENTS, CHAT_EVENT_LABELS } from '../integrations/chat';
import { integrationsEnabled, sendTestMessage } from '../integrations/notify';

const app = new Hono<AppContext>();

app.use('/rest/api/2/project/*/inbound-sources*', sessionMiddleware);
app.use('/rest/api/2/project/*/notification-channels*', sessionMiddleware);
app.use('/rest/api/2/admin/notification-channels*', sessionMiddleware);

const envInt = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};
const newSecret = () => randomBytes(32).toString('base64url');
const newSlug = () => randomBytes(18).toString('base64url');
const baseUrl = (c: any) => (process.env.PUBLIC_URL || process.env.BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
const notFound = (c: any, what = 'Not found') => c.json({ errorMessages: [what] }, 404);
const bad = (c: any, msgs: string[]) => c.json({ errorMessages: msgs }, 400);

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

/* ================================================================== */
/*  Inbound webhooks: public ingestion                                  */
/* ================================================================== */

async function readCapped(c: any, max: number): Promise<string | null> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = c.req.raw.body;
  if (!body) return '';
  // JSON bodies were already read (and capped at the global limit) by bodyGuard; Hono serves them from its cache.
  if (body.locked || c.req.raw.bodyUsed) {
    const text = await c.req.text();
    return Buffer.byteLength(text) > max ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Public by design: authenticated by the source's HMAC signature or shared secret, never by a session. */
app.post('/rest/api/2/webhooks/inbound/:slug', async (c) => {
  const slug = c.req.param('slug');

  // Per-source throttle, stricter than the global limiter; applied before any lookup so unknown slugs cost the same.
  const limit = await isAllowed(`veqsio:ratelimit:inbound:${slug.slice(0, 64)}:${getClientIP(c)}`, { maxRequests: envInt('INBOUND_RATE_LIMIT_MAX', 120), windowMs: 60_000 });
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    return c.json({ errorMessages: ['Rate limit exceeded'] }, 429);
  }

  const [source] = await db.select().from(schema.inboundSources).where(eq(schema.inboundSources.slug, slug)).limit(1);
  if (!source || !source.enabled || !(await integrationsEnabled(source.projectId))) return notFound(c);

  const maxBytes = envInt('INBOUND_BODY_LIMIT_BYTES', 256 * 1024);
  const raw = await readCapped(c, maxBytes);
  if (raw === null) return c.json({ errorMessages: ['Payload too large'] }, 413);

  let secret: string;
  try { secret = decryptSecret(source.secretEnc); } catch { return c.json({ errorMessages: ['Internal error'] }, 500); }
  const get = (n: string) => c.req.header(n);
  let authed: boolean;
  if (source.type === 'sentry') authed = verifyHmac(secret, raw, get(SENTRY_SIGNATURE_HEADER));
  else if (source.authMode === 'header') authed = safeEqual(providedSecret(get), secret) && providedSecret(get) !== '';
  else authed = verifyHmac(secret, raw, get('x-veqsio-signature') ?? get('x-hub-signature-256'));
  if (!authed) return c.json({ errorMessages: ['Unauthorized'] }, 401);

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400); }
  if (payload === null || typeof payload !== 'object') return c.json({ errorMessages: ['The payload must be a JSON object or array'] }, 400);

  const result = await receive(source, { rawBody: raw, payload, headerIdempotencyKey: headerIdempotencyKey(get, source.type) });
  // Deliberately terse: nothing about the project or the actor goes back to the caller.
  const body: Record<string, unknown> = { status: result.status };
  if (result.issueKey) body.key = result.issueKey;
  if (result.status === 'ignored' || result.status === 'duplicate') body.reason = result.reason;
  return c.json(body, result.httpStatus as 200 | 201 | 422 | 500);
});

/* ================================================================== */
/*  Inbound webhooks: administration                                    */
/* ================================================================== */

const SOURCE_TYPES = ['generic', 'sentry'] as const;

const sourceBase = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  mapping: mappingSchema.optional(),
  issueTypeId: z.number().int().positive().nullable().optional(),
  actorUserId: z.number().int().positive().nullable().optional(),
};
const sourceCreate = z.object({
  ...sourceBase,
  type: z.enum(SOURCE_TYPES).default('generic'),
  authMode: z.enum(['hmac', 'header']).default('hmac'),
}).strict();
const sourceUpdate = z.object({
  ...sourceBase,
  name: sourceBase.name.optional(),
  authMode: z.enum(['hmac', 'header']).optional(),
}).strict();

const sourceView = (c: any, s: Source, actor?: { id: number; displayName: string } | null) => ({
  id: s.id, projectId: s.projectId, name: s.name, type: s.type, enabled: s.enabled, authMode: s.type === 'sentry' ? 'hmac' : s.authMode,
  mapping: s.mapping, issueTypeId: s.issueTypeId, actorUserId: s.actorUserId, actor: actor ?? null,
  url: `${baseUrl(c)}/rest/api/2/webhooks/inbound/${s.slug}`,
  signatureHeader: s.type === 'sentry' ? 'Sentry-Hook-Signature' : s.authMode === 'header' ? 'X-Veqsio-Secret' : 'X-Veqsio-Signature',
  createdAt: s.createdAt, updatedAt: s.updatedAt,
});

async function actorOf(id: number | null) {
  if (!id) return null;
  const [u] = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u ?? null;
}

async function validateTargets(projectId: number, issueTypeId: number | null | undefined, actorUserId: number | null | undefined): Promise<string | null> {
  if (issueTypeId) {
    const [t] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, issueTypeId)).limit(1);
    if (!t || t.isSubtask) return 'Unknown or unsupported issue type';
  }
  if (actorUserId) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).limit(1);
    if (!u || u.active === false) return 'Unknown or inactive actor user';
  }
  return null;
}

const uniqueViolation = (e: any) => String(e?.cause?.code ?? e?.code) === '23505';

async function sourceOf(c: any): Promise<{ project: NonNullable<Awaited<ReturnType<typeof projectByKey>>>; source: Source } | null> {
  const project = await projectByKey(c.req.param('key'));
  const id = Number(c.req.param('sourceId'));
  if (!project || !Number.isInteger(id)) return null;
  const [source] = await db.select().from(schema.inboundSources).where(and(eq(schema.inboundSources.id, id), eq(schema.inboundSources.projectId, project.id))).limit(1);
  return source ? { project, source } : null;
}

app.get('/rest/api/2/project/:key/inbound-sources', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return notFound(c, 'Project not found');
  const rows = await db.select().from(schema.inboundSources).where(eq(schema.inboundSources.projectId, p.id)).orderBy(schema.inboundSources.id);
  const actors = rows.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, rows.map((r) => r.actorUserId).filter((x): x is number => !!x))) : [];
  return c.json(rows.map((r) => sourceView(c, r, actors.find((a) => a.id === r.actorUserId))));
});

app.post('/rest/api/2/project/:key/inbound-sources', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return notFound(c, 'Project not found');
  if (!secretsConfigured()) return bad(c, ['SECRETS_ENCRYPTION_KEY is not configured, the source secret cannot be stored']);
  const parsed = sourceCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => i.message));
  const b = parsed.data;
  const actorUserId = b.actorUserId ?? c.get('user')!.id;
  const err = await validateTargets(p.id, b.issueTypeId, actorUserId);
  if (err) return bad(c, [err]);
  const secret = newSecret();
  try {
    const [row] = await db.insert(schema.inboundSources).values({
      projectId: p.id, name: b.name, slug: newSlug(), type: b.type, enabled: b.enabled ?? true,
      authMode: b.type === 'sentry' ? 'hmac' : b.authMode, secretEnc: encryptSecret(secret), mapping: b.mapping ?? {},
      issueTypeId: b.issueTypeId ?? null, actorUserId, createdBy: c.get('user')!.id,
    }).returning();
    // The secret is shown once.
    return c.json({ ...sourceView(c, row, await actorOf(actorUserId)), secret }, 201);
  } catch (e) {
    if (uniqueViolation(e)) return c.json({ errorMessages: ['A source with this name already exists'] }, 409);
    throw e;
  }
});

app.put('/rest/api/2/project/:key/inbound-sources/:sourceId', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const found = await sourceOf(c);
  if (!found) return notFound(c);
  const parsed = sourceUpdate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => i.message));
  const b = parsed.data;
  const err = await validateTargets(found.project.id, b.issueTypeId, b.actorUserId);
  if (err) return bad(c, [err]);
  const set: Partial<typeof schema.inboundSources.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name;
  if (b.enabled !== undefined) set.enabled = b.enabled;
  if (b.mapping !== undefined) set.mapping = b.mapping;
  if (b.issueTypeId !== undefined) set.issueTypeId = b.issueTypeId;
  if (b.actorUserId !== undefined) set.actorUserId = b.actorUserId;
  if (b.authMode !== undefined && found.source.type !== 'sentry') set.authMode = b.authMode;
  try {
    const [row] = await db.update(schema.inboundSources).set(set).where(eq(schema.inboundSources.id, found.source.id)).returning();
    return c.json(sourceView(c, row, await actorOf(row.actorUserId)));
  } catch (e) {
    if (uniqueViolation(e)) return c.json({ errorMessages: ['A source with this name already exists'] }, 409);
    throw e;
  }
});

app.post('/rest/api/2/project/:key/inbound-sources/:sourceId/rotate-secret', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const found = await sourceOf(c);
  if (!found) return notFound(c);
  const secret = newSecret();
  const [row] = await db.update(schema.inboundSources).set({ secretEnc: encryptSecret(secret), updatedAt: new Date() }).where(eq(schema.inboundSources.id, found.source.id)).returning();
  return c.json({ ...sourceView(c, row, await actorOf(row.actorUserId)), secret });
});

app.delete('/rest/api/2/project/:key/inbound-sources/:sourceId', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const found = await sourceOf(c);
  if (!found) return notFound(c);
  await db.delete(schema.inboundSources).where(eq(schema.inboundSources.id, found.source.id));
  return c.json({});
});

app.get('/rest/api/2/project/:key/inbound-sources/:sourceId/deliveries', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const found = await sourceOf(c);
  if (!found) return notFound(c);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
  const rows = await db.select({ d: schema.inboundDeliveries, key: schema.issues.issueKey })
    .from(schema.inboundDeliveries).leftJoin(schema.issues, eq(schema.issues.id, schema.inboundDeliveries.issueId))
    .where(eq(schema.inboundDeliveries.sourceId, found.source.id)).orderBy(desc(schema.inboundDeliveries.id)).limit(limit);
  return c.json(rows.map(({ d, key }) => ({
    id: d.id, status: d.status, reason: d.reason, idempotencyKey: d.idempotencyKey, dedupKey: d.dedupKey, issueKey: key, payload: d.payload, isTest: d.isTest, createdAt: d.createdAt,
  })));
});

const testBody = z.object({ payload: z.record(z.string(), z.unknown()).or(z.array(z.unknown())), dryRun: z.boolean().default(true) }).strict();

/** Test button: dry run (default) shows the mapped fields and the planned action; dryRun=false really processes the sample as a test delivery. */
app.post('/rest/api/2/project/:key/inbound-sources/:sourceId/test', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const found = await sourceOf(c);
  if (!found) return notFound(c);
  const parsed = testBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, ['payload (object) is required']);
  const raw = JSON.stringify(parsed.data.payload);
  if (raw.length > envInt('INBOUND_BODY_LIMIT_BYTES', 256 * 1024)) return c.json({ errorMessages: ['Payload too large'] }, 413);
  if (parsed.data.dryRun) return c.json({ dryRun: true, ...(await dryRun(found.source, parsed.data.payload)) });
  const result = await receive(found.source, { rawBody: raw, payload: parsed.data.payload, headerIdempotencyKey: null, isTest: true });
  return c.json({ dryRun: false, status: result.status, key: result.issueKey ?? null, reason: result.reason ?? null });
});

/* ================================================================== */
/*  Notification channels (project and instance default)                */
/* ================================================================== */

const eventEnum = z.enum(CHAT_EVENTS);
const settingsSchema = z.object({ teamsFormat: z.enum(['adaptive', 'messagecard']).optional() }).strict();
const channelCreate = z.object({
  type: z.enum(['slack', 'teams']),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(2000),
  events: z.array(eventEnum).min(1).max(CHAT_EVENTS.length),
  settings: settingsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();
const channelUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().url().max(2000).optional(),
  events: z.array(eventEnum).min(1).max(CHAT_EVENTS.length).optional(),
  settings: settingsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

type Channel = typeof schema.notificationChannels.$inferSelect;
function maskedUrl(ch: Channel): string {
  try { const u = new URL(decryptSecret(ch.urlEnc)); return `${u.protocol}//${u.host}/…`; } catch { return '(unreadable)'; }
}
const channelView = (ch: Channel) => ({
  id: ch.id, projectId: ch.projectId, type: ch.type, name: ch.name, url: maskedUrl(ch), events: ch.events, settings: ch.settings,
  enabled: ch.enabled, consecutiveFailures: ch.consecutiveFailures, createdAt: ch.createdAt,
});
const eventCatalog = CHAT_EVENTS.map((id) => ({ id, label: CHAT_EVENT_LABELS[id] }));

/** Registers the channel routes under `base`; `scope` resolves the project (null = instance default) or answers 404. */
function channelRoutes(base: string, guards: any[], scope: (c: any) => Promise<{ projectId: number | null } | null>) {
  const r = app as any;
  const own = async (c: any, projectId: number | null): Promise<Channel | null> => {
    const id = Number(c.req.param('channelId'));
    if (!Number.isInteger(id)) return null;
    const [ch] = await db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, id)).limit(1);
    return ch && ch.projectId === projectId ? ch : null;
  };

  r.get(base, ...guards, async (c: any) => {
    const s = await scope(c);
    if (!s) return notFound(c);
    const list = await db.select().from(schema.notificationChannels)
      .where(s.projectId === null ? isNull(schema.notificationChannels.projectId) : eq(schema.notificationChannels.projectId, s.projectId)).orderBy(schema.notificationChannels.id);
    return c.json({ channels: list.map(channelView), events: eventCatalog });
  });

  r.post(base, ...guards, async (c: any) => {
    const s = await scope(c);
    if (!s) return notFound(c);
    if (!secretsConfigured()) return bad(c, ['SECRETS_ENCRYPTION_KEY is not configured, the webhook URL cannot be stored']);
    const parsed = channelCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error.issues.map((i) => i.message));
    const b = parsed.data;
    try { await assertPublicUrl(b.url); } catch (e: any) { return bad(c, [e.message || 'URL is not allowed']); }
    const [row] = await db.insert(schema.notificationChannels).values({
      projectId: s.projectId, type: b.type, name: b.name, urlEnc: encryptSecret(b.url), events: [...new Set(b.events)],
      settings: b.settings ?? {}, enabled: b.enabled ?? true, createdBy: c.get('user')!.id,
    }).returning();
    return c.json(channelView(row), 201);
  });

  r.put(`${base}/:channelId`, ...guards, async (c: any) => {
    const s = await scope(c);
    const ch = s ? await own(c, s.projectId) : null;
    if (!ch) return notFound(c);
    const parsed = channelUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error.issues.map((i) => i.message));
    const b = parsed.data;
    const set: Partial<typeof schema.notificationChannels.$inferInsert> = {};
    if (b.url !== undefined) {
      try { await assertPublicUrl(b.url); } catch (e: any) { return bad(c, [e.message || 'URL is not allowed']); }
      set.urlEnc = encryptSecret(b.url);
      set.consecutiveFailures = 0;
    }
    if (b.name !== undefined) set.name = b.name;
    if (b.events !== undefined) set.events = [...new Set(b.events)];
    if (b.settings !== undefined) set.settings = b.settings;
    if (b.enabled !== undefined) { set.enabled = b.enabled; if (b.enabled) set.consecutiveFailures = 0; }
    const [row] = Object.keys(set).length
      ? await db.update(schema.notificationChannels).set(set).where(eq(schema.notificationChannels.id, ch.id)).returning()
      : [ch];
    return c.json(channelView(row));
  });

  r.delete(`${base}/:channelId`, ...guards, async (c: any) => {
    const s = await scope(c);
    const ch = s ? await own(c, s.projectId) : null;
    if (!ch) return notFound(c);
    await db.delete(schema.notificationChannels).where(eq(schema.notificationChannels.id, ch.id));
    return c.json({});
  });

  r.post(`${base}/:channelId/test`, ...guards, async (c: any) => {
    const s = await scope(c);
    const ch = s ? await own(c, s.projectId) : null;
    if (!ch) return notFound(c);
    const r = await sendTestMessage(ch);
    return c.json({ ok: r.ok, status: r.status, error: r.error, attempts: r.attempts }, r.ok ? 200 : 502);
  });

  r.get(`${base}/:channelId/deliveries`, ...guards, async (c: any) => {
    const s = await scope(c);
    const ch = s ? await own(c, s.projectId) : null;
    if (!ch) return notFound(c);
    const rows = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.channelId, ch.id)).orderBy(desc(schema.notificationDeliveries.id)).limit(50);
    return c.json(rows.map((d) => ({ id: d.id, event: d.event, status: d.status, responseStatus: d.responseStatus, error: d.error, attempts: d.attempts, latencyMs: d.latencyMs, createdAt: d.createdAt })));
  });
}

channelRoutes('/rest/api/2/project/:key/notification-channels', [requireAuth, requirePermission('PROJECT_ADMIN')], async (c) => {
  const p = await projectByKey(c.req.param('key'));
  return p ? { projectId: p.id } : null;
});
channelRoutes('/rest/api/2/admin/notification-channels', [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')], async () => ({ projectId: null }));

export default app;
