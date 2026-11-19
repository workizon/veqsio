/**
 * IMAP polling for the service desk e-mail channel.
 *
 * The processing core talks to an abstract `MailSource` (list unseen, fetch source, mark seen) so it is unit-testable
 * with a fake; `imapflowSource` is the production implementation. Rules:
 *  - disabled by default, interval >= 60 s, one poller per desk at a time (a DB lease, so several API instances are safe)
 *  - a message is marked seen only after it was processed (request / comment / deliberately rejected); an unexpected
 *    error leaves it unseen so the next poll retries it
 *  - the Message-ID claim in sd_inbound_messages makes redelivery and crashes between "processed" and "seen" harmless
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { ImapFlow } from 'imapflow'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { decryptSecret } from '../auth/secrets'
import { normalizeAddress, sanitizeSubject } from './inbound-email'
import { parseRawMessage, type NormalizedMail } from './mime'
import { processInboundMail } from './inbound-process'

type Desk = typeof schema.serviceDesks.$inferSelect
type Channel = typeof schema.sdEmailChannels.$inferSelect

export const MIN_POLL_SECONDS = 60
export const MAX_POLL_SECONDS = 86_400
/** Messages handled per poll; the rest waits for the next one. */
export const MAX_MESSAGES_PER_POLL = 50
/** Messages larger than this are rejected without being downloaded. */
export const maxMessageBytes = () => {
  const n = Number(process.env.INBOUND_MAX_MESSAGE_BYTES)
  return Number.isInteger(n) && n > 0 ? n : 25 * 1024 * 1024
}
const LEASE_MS = 5 * 60_000

export interface ImapSettings { host: string; port: number; tls: boolean; user: string; password: string; folder: string }

export interface MailSource {
  open(): Promise<void>
  /** Unseen messages, oldest first. */
  listUnseen(limit: number): Promise<Array<{ uid: number; size: number }>>
  fetch(uid: number): Promise<Uint8Array>
  markSeen(uid: number): Promise<void>
  close(): Promise<void>
}

export type MailSourceFactory = (s: ImapSettings) => MailSource
let factoryOverride: MailSourceFactory | null = null
/** Tests inject a fake mailbox; pass null to restore IMAP. */
export function setMailSourceFactoryForTests(f: MailSourceFactory | null): void { factoryOverride = f }

/** Hosts an admin may not point the poller at (link-local / cloud metadata). Private ranges stay allowed: mail servers live there. */
export function isBlockedImapHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return /^169\.254\./.test(h) || h === 'metadata.google.internal' || h === 'metadata' || /^fe80:/.test(h) || h === 'fd00:ec2::254'
}

/** Normalised poll interval in seconds (>= 60). */
export function clampPollSeconds(n: unknown): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return 300
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, v))
}

/** Is the desk's poller due? */
export function isPollDue(ch: Pick<Channel, 'imapEnabled' | 'imapHost' | 'imapUser' | 'imapPasswordEncrypted' | 'imapPollSeconds' | 'imapLastPollAt'>, now = Date.now()): boolean {
  if (!ch.imapEnabled || !ch.imapHost || !ch.imapUser || !ch.imapPasswordEncrypted) return false
  if (!ch.imapLastPollAt) return true
  return now - ch.imapLastPollAt.getTime() >= clampPollSeconds(ch.imapPollSeconds) * 1000
}

/** Production mail source on top of imapflow. */
export function imapflowSource(s: ImapSettings): MailSource {
  const client = new ImapFlow({
    host: s.host, port: s.port, secure: s.tls, auth: { user: s.user, pass: s.password }, logger: false,
    tls: { rejectUnauthorized: true }, socketTimeout: 60_000, greetingTimeout: 20_000, connectionTimeout: 20_000,
  } as ConstructorParameters<typeof ImapFlow>[0])
  let lock: { release: () => void } | null = null
  return {
    async open() {
      client.on('error', () => { /* surfaced through the failing call */ })
      await client.connect()
      lock = await client.getMailboxLock(s.folder)
    },
    async listUnseen(limit) {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[]
      const out: Array<{ uid: number; size: number }> = []
      for (const uid of uids.sort((a, b) => a - b).slice(0, limit)) {
        const m = await client.fetchOne(String(uid), { size: true }, { uid: true })
        out.push({ uid, size: m ? Number(m.size ?? 0) : 0 })
      }
      return out
    },
    async fetch(uid) {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true })
      if (!m || !m.source) throw new Error('Message vanished')
      return m.source
    },
    async markSeen(uid) { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) },
    async close() {
      try { lock?.release() } catch { /* ignore */ }
      try { await client.logout() } catch { try { client.close() } catch { /* ignore */ } }
    },
  }
}

const makeSource = (s: ImapSettings) => (factoryOverride ?? imapflowSource)(s)

const errText = (e: unknown) => {
  const m = (e as { responseText?: string; message?: string })
  return String(m?.responseText || m?.message || e).replace(/\s+/g, ' ').slice(0, 300)
}

/** Settings of a channel with the password decrypted; null when something is missing. */
export function settingsOf(ch: Channel): ImapSettings | null {
  if (!ch.imapHost || !ch.imapUser || !ch.imapPasswordEncrypted) return null
  return {
    host: ch.imapHost, port: ch.imapPort, tls: ch.imapTls, user: ch.imapUser,
    password: decryptSecret(ch.imapPasswordEncrypted), folder: ch.imapFolder || 'INBOX',
  }
}

export type TestResult = { ok: true; unseen: number } | { ok: false; error: string }

/** Connect, open the folder and count unseen mail. Never throws. */
export async function testImapConnection(s: ImapSettings): Promise<TestResult> {
  if (isBlockedImapHost(s.host)) return { ok: false, error: 'This host is not allowed' }
  const src = makeSource(s)
  try {
    await src.open()
    const unseen = await src.listUnseen(1000)
    return { ok: true, unseen: unseen.length }
  } catch (e) {
    return { ok: false, error: errText(e) }
  } finally {
    await src.close().catch(() => {})
  }
}

export interface PollSummary { processed: number; created: number; commented: number; rejected: number; errors: number; skippedBig: number }

/** Process one message of the mailbox. Returns true when it may be marked seen. */
async function handleMessage(desk: Desk, ch: Channel, raw: Uint8Array, sum: PollSummary): Promise<boolean> {
  let mail: NormalizedMail
  try {
    mail = await parseRawMessage(raw)
  } catch {
    sum.rejected++
    return true // unreadable for good: do not retry forever
  }
  const from = normalizeAddress(mail.from) ?? 'invalid'
  const [claim] = await db.insert(schema.sdInboundMessages).values({
    serviceDeskId: desk.id, messageId: mail.messageId.slice(0, 500), fromAddress: from.slice(0, 320),
    subject: sanitizeSubject(mail.subject).slice(0, 500), status: 'rejected', reason: 'processing',
  }).onConflictDoNothing().returning({ id: schema.sdInboundMessages.id })
  if (!claim) return true // already handled (crash between processing and marking seen, or a copy of the same message)

  try {
    const out = await processInboundMail(desk, ch, mail)
    await db.update(schema.sdInboundMessages)
      .set({ status: out.status, reason: out.reason ?? null, issueId: out.issueId ?? null })
      .where(eq(schema.sdInboundMessages.id, claim.id))
    sum[out.status]++
    return true
  } catch (e) {
    await db.delete(schema.sdInboundMessages).where(eq(schema.sdInboundMessages.id, claim.id)).catch(() => {})
    sum.errors++
    console.error('[servicedesk-imap] processing failed:', (e as Error)?.name, errText(e))
    throw e
  }
}

/** Acquire the per-channel lease; false when another poller holds it. */
async function acquireLease(chId: number): Promise<boolean> {
  const rows = await db.update(schema.sdEmailChannels)
    .set({ imapLockUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(schema.sdEmailChannels.id, chId), or(isNull(schema.sdEmailChannels.imapLockUntil), lt(schema.sdEmailChannels.imapLockUntil, sql`now()`))))
    .returning({ id: schema.sdEmailChannels.id })
  return rows.length > 0
}

/** Poll one desk's mailbox once. Records the result on the channel. Safe to call concurrently (lease). */
export async function pollDesk(desk: Desk, ch: Channel): Promise<PollSummary | { skipped: 'locked' | 'not-configured' }> {
  let settings: ImapSettings | null
  try { settings = settingsOf(ch) } catch (e) {
    await recordPoll(ch.id, 'error', 'Stored password could not be decrypted, enter it again', null)
    return { skipped: 'not-configured' }
  }
  if (!settings || isBlockedImapHost(settings.host)) return { skipped: 'not-configured' }
  if (!(await acquireLease(ch.id))) return { skipped: 'locked' }

  const sum: PollSummary = { processed: 0, created: 0, commented: 0, rejected: 0, errors: 0, skippedBig: 0 }
  const src = makeSource(settings)
  let failure: string | null = null
  try {
    await src.open()
    const list = await src.listUnseen(MAX_MESSAGES_PER_POLL)
    for (const m of list) {
      try {
        if (m.size > maxMessageBytes()) {
          sum.skippedBig++
          await src.markSeen(m.uid) // too large to ever process: flag it and move on
          continue
        }
        const raw = await src.fetch(m.uid)
        const done = await handleMessage(desk, ch, raw, sum)
        sum.processed++
        if (done) await src.markSeen(m.uid) // only after success
      } catch (e) {
        failure = failure ?? errText(e) // leave unseen; the next poll retries
      }
    }
  } catch (e) {
    failure = errText(e)
  } finally {
    await src.close().catch(() => {})
  }
  await recordPoll(ch.id, failure ? 'error' : 'ok', failure, sum.processed)
  return sum
}

async function recordPoll(chId: number, status: 'ok' | 'error', error: string | null, count: number | null) {
  await db.update(schema.sdEmailChannels).set({
    imapLastPollAt: new Date(), imapLastStatus: status, imapLastError: error, imapLastCount: count, imapLockUntil: null,
  }).where(eq(schema.sdEmailChannels.id, chId))
}

/** Scheduler entry: poll every enabled desk whose interval elapsed. Returns the number of desks polled. */
export async function pollDueDesks(now = Date.now()): Promise<number> {
  const rows = await db.select({ desk: schema.serviceDesks, ch: schema.sdEmailChannels })
    .from(schema.sdEmailChannels).innerJoin(schema.serviceDesks, eq(schema.serviceDesks.id, schema.sdEmailChannels.serviceDeskId))
    .where(and(eq(schema.sdEmailChannels.imapEnabled, true), eq(schema.sdEmailChannels.enabled, true), eq(schema.serviceDesks.enabled, true)))
  let n = 0
  for (const { desk, ch } of rows) {
    if (!isPollDue(ch, now)) continue
    const r = await pollDesk(desk, ch).catch((e) => { console.error('[servicedesk-imap] poll failed:', errText(e)); return null })
    if (r && !('skipped' in r)) n++
  }
  return n
}
