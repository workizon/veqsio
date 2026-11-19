import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { getDeskRole, type DeskRole } from '../servicedesk/service'
import { getClientIP, isAllowed } from '../middleware/rate-limit'
import { normalizeAddress, sanitizeSubject, normalizeDomains } from '../servicedesk/inbound-email'
import { processInboundMail, type InboundOutcome } from '../servicedesk/inbound-process'
import {
  MIN_POLL_SECONDS, MAX_POLL_SECONDS, clampPollSeconds, isBlockedImapHost, pollDesk, settingsOf, testImapConnection, type ImapSettings,
} from '../servicedesk/imap-poller'
import { encryptSecret, secretsConfigured } from '../auth/secrets'

const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403)

type Desk = typeof schema.serviceDesks.$inferSelect
type Channel = typeof schema.sdEmailChannels.$inferSelect

const MAX_REQUEST_BYTES = 300_000
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')
export const newSecret = () => randomBytes(32).toString('hex')

/** Constant-time comparison of the sha256 digests (equal length, so no early exit). */
export function secretMatches(provided: string, storedHash: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = Buffer.from(storedHash.length === 64 ? storedHash : '0'.repeat(64), 'hex')
  return b.length === a.length && timingSafeEqual(a, b)
}

/* ------------------------------------------------------------------ */
/*  Admin                                                              */
/* ------------------------------------------------------------------ */

const domainRe = /^@?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
const hostRe = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i
const imapUpdate = z.object({
  enabled: z.boolean().optional(),
  host: z.string().trim().max(255).regex(hostRe, 'Invalid host').nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  user: z.string().trim().min(1).max(320).nullable().optional(),
  /** Write-only. Omit or send an empty string to keep the stored password. */
  password: z.string().max(1000).optional(),
  folder: z.string().trim().min(1).max(255).optional(),
  pollSeconds: z.number().int().min(MIN_POLL_SECONDS, `Poll interval must be at least ${MIN_POLL_SECONDS} seconds`).max(MAX_POLL_SECONDS).optional(),
}).strict()
const channelUpdate = z.object({
  enabled: z.boolean().optional(),
  defaultRequestTypeId: z.number().int().positive().nullable().optional(),
  allowedSenderDomains: z.array(z.string().max(253).regex(domainRe)).max(50).optional(),
  replyAddress: z.string().trim().max(320).email().nullable().optional(),
  imap: imapUpdate.optional(),
}).strict()
const imapTestBody = z.object({
  host: z.string().trim().max(255).regex(hostRe, 'Invalid host').optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  user: z.string().trim().min(1).max(320).optional(),
  password: z.string().max(1000).optional(),
  folder: z.string().trim().min(1).max(255).optional(),
}).strict()

async function adminGuard(c: any): Promise<{ desk: Desk } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return notFound(c)
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  if (!desk) return notFound(c)
  const role: DeskRole = await getDeskRole(c.get('user'), desk)
  if (role === 'none' || role === 'customer') return notFound(c) // do not reveal desk ids
  if (role !== 'admin') return forbidden(c)
  return { desk }
}
const isResponse = (v: unknown): v is Response => v instanceof Response

/** Public view: never includes the secret or its hash. */
function channelView(desk: Desk, ch: Channel | undefined) {
  return {
    configured: !!ch,
    enabled: ch?.enabled ?? false,
    defaultRequestTypeId: ch?.defaultRequestTypeId ?? null,
    allowedSenderDomains: (ch?.allowedSenderDomains as string[] | undefined) ?? [],
    inboundPath: `/rest/servicedeskapi/inbound-email/${desk.slug}`,
    replyAddress: ch?.replyAddress ?? null,
    // The password is never returned, only whether one is stored.
    imap: {
      enabled: ch?.imapEnabled ?? false,
      host: ch?.imapHost ?? '',
      port: ch?.imapPort ?? 993,
      tls: ch?.imapTls ?? true,
      user: ch?.imapUser ?? '',
      passwordSet: !!ch?.imapPasswordEncrypted,
      folder: ch?.imapFolder ?? 'INBOX',
      pollSeconds: ch?.imapPollSeconds ?? 300,
      lastPollAt: ch?.imapLastPollAt ?? null,
      lastStatus: ch?.imapLastStatus ?? null,
      lastError: ch?.imapLastError ?? null,
      lastCount: ch?.imapLastCount ?? null,
    },
  }
}

const loadChannel = async (deskId: number) =>
  (await db.select().from(schema.sdEmailChannels).where(eq(schema.sdEmailChannels.serviceDeskId, deskId)).limit(1))[0]

app.get('/rest/servicedeskapi/servicedesk/:id/email-channel', requireAuth, async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  return c.json(channelView(g.desk, await loadChannel(g.desk.id)))
})

app.put('/rest/servicedeskapi/servicedesk/:id/email-channel', requireAuth, zValidator('json', channelUpdate), async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  const body = c.req.valid('json')
  if (body.defaultRequestTypeId != null) {
    const [rt] = await db.select({ id: schema.requestTypes.id }).from(schema.requestTypes).where(and(
      eq(schema.requestTypes.id, body.defaultRequestTypeId), eq(schema.requestTypes.serviceDeskId, g.desk.id),
    )).limit(1)
    if (!rt) return c.json({ errorMessages: ['Unknown request type'] }, 400)
  }
  const patch: Partial<typeof schema.sdEmailChannels.$inferInsert> = {}
  if (body.replyAddress !== undefined) patch.replyAddress = body.replyAddress
  const existingCh = await loadChannel(g.desk.id)
  if (body.imap) {
    const i = body.imap
    if (i.host && isBlockedImapHost(i.host)) return c.json({ errorMessages: ['This host is not allowed'] }, 400)
    if (i.host !== undefined) patch.imapHost = i.host
    if (i.port !== undefined) patch.imapPort = i.port
    if (i.tls !== undefined) patch.imapTls = i.tls
    if (i.user !== undefined) patch.imapUser = i.user
    if (i.folder !== undefined) patch.imapFolder = i.folder
    if (i.pollSeconds !== undefined) patch.imapPollSeconds = clampPollSeconds(i.pollSeconds)
    if (i.password) {
      if (!secretsConfigured()) return c.json({ errorMessages: ['SECRETS_ENCRYPTION_KEY is not configured, the mailbox password cannot be stored'] }, 400)
      patch.imapPasswordEncrypted = encryptSecret(i.password)
    }
    if (i.enabled !== undefined) {
      if (i.enabled) {
        const host = i.host !== undefined ? i.host : existingCh?.imapHost
        const user = i.user !== undefined ? i.user : existingCh?.imapUser
        if (!host || !user || !(patch.imapPasswordEncrypted ?? existingCh?.imapPasswordEncrypted)) {
          return c.json({ errorMessages: ['Host, user and password are required to enable IMAP polling'] }, 400)
        }
      }
      patch.imapEnabled = i.enabled
    }
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled
  if (body.defaultRequestTypeId !== undefined) patch.defaultRequestTypeId = body.defaultRequestTypeId
  if (body.allowedSenderDomains !== undefined) patch.allowedSenderDomains = normalizeDomains(body.allowedSenderDomains)

  const existing = existingCh
  if (existing) {
    const [row] = Object.keys(patch).length
      ? await db.update(schema.sdEmailChannels).set(patch).where(eq(schema.sdEmailChannels.id, existing.id)).returning()
      : [existing]
    return c.json(channelView(g.desk, row))
  }
  // First configuration: create the channel and reveal the generated secret once.
  const secret = newSecret()
  const [row] = await db.insert(schema.sdEmailChannels)
    .values({ ...patch, serviceDeskId: g.desk.id, secretHash: sha256Hex(secret) })
    .onConflictDoNothing().returning()
  if (!row) return c.json({ errorMessages: ['Conflict, please retry'] }, 409)
  return c.json({ ...channelView(g.desk, row), secret }, 201)
})

/** Try the mailbox with the given (or stored) settings. Admin only; never returns the password. */
app.post('/rest/servicedeskapi/servicedesk/:id/email-channel/test-connection', requireAuth, zValidator('json', imapTestBody), async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const ch = await loadChannel(g.desk.id)
  let stored: ImapSettings | null = null
  try { stored = ch ? settingsOf(ch) : null } catch { stored = null }
  const host = b.host ?? ch?.imapHost
  const user = b.user ?? ch?.imapUser
  const password = b.password || stored?.password
  if (!host || !user || !password) return c.json({ ok: false, error: 'Host, user and password are required' }, 400)
  const result = await testImapConnection({
    host, user, password, port: b.port ?? ch?.imapPort ?? 993, tls: b.tls ?? ch?.imapTls ?? true, folder: b.folder ?? ch?.imapFolder ?? 'INBOX',
  })
  return c.json(result)
})

/** Poll now (admin), e.g. after fixing credentials. Respects the lease. */
app.post('/rest/servicedeskapi/servicedesk/:id/email-channel/poll', requireAuth, async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  const ch = await loadChannel(g.desk.id)
  if (!ch || !ch.imapHost) return c.json({ errorMessages: ['IMAP is not configured'] }, 400)
  const r = await pollDesk(g.desk, ch)
  return c.json('skipped' in r ? { status: r.skipped } : { status: 'done', ...r })
})

/** Recent inbound messages incl. rejected ones (so ignored mail is visible). */
app.get('/rest/servicedeskapi/servicedesk/:id/email-channel/messages', requireAuth, async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  const rows = await db.select().from(schema.sdInboundMessages)
    .where(eq(schema.sdInboundMessages.serviceDeskId, g.desk.id)).orderBy(desc(schema.sdInboundMessages.id)).limit(30)
  return c.json({ values: rows.map((r) => ({ id: r.id, from: r.fromAddress, subject: r.subject, status: r.status, reason: r.reason, created: r.createdAt })) })
})

app.post('/rest/servicedeskapi/servicedesk/:id/email-channel/rotate-secret', requireAuth, async (c) => {
  const g = await adminGuard(c); if (isResponse(g)) return g
  const secret = newSecret()
  await db.insert(schema.sdEmailChannels)
    .values({ serviceDeskId: g.desk.id, secretHash: sha256Hex(secret) })
    .onConflictDoUpdate({ target: schema.sdEmailChannels.serviceDeskId, set: { secretHash: sha256Hex(secret) } })
  c.header('Cache-Control', 'no-store')
  return c.json({ secret })
})

/* ------------------------------------------------------------------ */
/*  Public inbound endpoint                                            */
/* ------------------------------------------------------------------ */

const inboundBody = z.object({
  messageId: z.string().trim().min(1).max(500),
  from: z.string().min(1).max(998),
  subject: z.string().max(5000).optional().default(''),
  text: z.string().max(200_000).optional().default(''),
  headers: z.record(z.string().max(200), z.string().max(2000)).optional()
    .refine((h) => !h || Object.keys(h).length <= 200, 'too many headers'),
}).strict()

app.post('/rest/servicedeskapi/inbound-email/:slug', async (c) => {
  const slug = c.req.param('slug')

  // Per-source throttle, stricter than the global limiter.
  const limit = await isAllowed(`veqsio:ratelimit:inbound-email:${slug}:${getClientIP(c)}`, { maxRequests: 120, windowMs: 60_000 })
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter))
    return c.json({ errorMessages: ['Rate limit exceeded'] }, 429)
  }

  const [found] = await db.select({ desk: schema.serviceDesks, ch: schema.sdEmailChannels })
    .from(schema.serviceDesks).innerJoin(schema.sdEmailChannels, eq(schema.sdEmailChannels.serviceDeskId, schema.serviceDesks.id))
    .where(eq(schema.serviceDesks.slug, slug)).limit(1)
  if (!found || !found.ch.enabled || !found.desk.enabled) return notFound(c)
  const { desk, ch } = found

  if (!secretMatches(c.req.header('x-veqsio-inbound-secret') ?? '', ch.secretHash)) {
    return c.json({ errorMessages: ['Unauthorized'] }, 401)
  }

  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_REQUEST_BYTES) return c.json({ errorMessages: ['Payload too large'] }, 413)
  const raw = await c.req.text()
  if (raw.length > MAX_REQUEST_BYTES) return c.json({ errorMessages: ['Payload too large'] }, 413)
  let json: unknown
  try { json = JSON.parse(raw) } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400) }
  const parsed = inboundBody.safeParse(json)
  if (!parsed.success) return c.json({ errorMessages: ['Invalid payload'] }, 400)
  const msg = parsed.data

  const from = normalizeAddress(msg.from)
  if (!from) return c.json({ errorMessages: ['Invalid sender address'] }, 400)
  const subject = sanitizeSubject(msg.subject)

  // Claim the message id first: concurrent/retried deliveries become duplicates.
  const [claim] = await db.insert(schema.sdInboundMessages).values({
    serviceDeskId: desk.id, messageId: msg.messageId, fromAddress: from, subject, status: 'rejected', reason: 'processing',
  }).onConflictDoNothing().returning({ id: schema.sdInboundMessages.id })
  if (!claim) return c.json({ status: 'duplicate' })

  let outcome: InboundOutcome
  try {
    outcome = await processInboundMail(desk, ch, {
      messageId: msg.messageId, from: msg.from, subject, text: msg.text, attachments: [],
      headers: Object.fromEntries(Object.entries(msg.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      inReplyTo: [], references: [],
    })
  } catch (e) {
    // Release the claim so the gateway's retry can be processed; never leak details.
    await db.delete(schema.sdInboundMessages).where(eq(schema.sdInboundMessages.id, claim.id))
    console.error('[servicedesk-email] processing failed:', (e as Error)?.name)
    return c.json({ errorMessages: ['Internal error'] }, 500)
  }

  await db.update(schema.sdInboundMessages)
    .set({ status: outcome.status, reason: outcome.reason ?? null, issueId: outcome.issueId ?? null })
    .where(eq(schema.sdInboundMessages.id, claim.id))

  // Deliberately generic: no account/reason details go back to the caller.
  if (outcome.status === 'rejected') return c.json({ status: 'rejected' })
  return c.json({ status: outcome.status, key: outcome.key }, outcome.status === 'created' ? 201 : 200)
})

export default app
