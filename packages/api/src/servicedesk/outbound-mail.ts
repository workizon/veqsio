/**
 * Customer e-mail of a service desk request: public agent replies, customer-visible status changes,
 * merge notices and "raised on your behalf" mail. Everything goes through the shared e-mail queue (retries,
 * one SMTP sender) with threading headers, so mail clients keep one conversation per request.
 *
 * Rules: internal comments never get here (callers pass public comments only); with SMTP unconfigured nothing is
 * queued (logged once per process); a per-request hourly cap stops runaway loops.
 */
import { usersWhoCanSee } from '../security/issue-security'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { getSmtpConfig, queueEmailWithHeaders } from '../services/email'
import { customerSideUserIds } from './access'
import { buildThreadHeaders, mailDomain, portalRequestUrl, requestSubject } from './mail-threading'

export type RequestMailKind = 'comment' | 'status' | 'merged' | 'created'

/** Maximum customer mails per request and hour (loop / flood guard). */
export const MAX_MAILS_PER_REQUEST_HOUR = 20
const MAX_BODY_CHARS = 8000

let warnedNoSmtp = false

export interface RequestMailResult { queued: number; skipped?: 'smtp' | 'not-a-request' | 'disabled' | 'no-recipients' | 'rate-limit' }

async function loadRequest(issueId: number) {
  const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests, desk: schema.serviceDesks })
    .from(schema.serviceRequests)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .innerJoin(schema.serviceDesks, eq(schema.serviceDesks.id, schema.serviceRequests.serviceDeskId))
    .where(eq(schema.serviceRequests.issueId, issueId)).limit(1)
  return row ?? null
}

/** Address customers should reply to: explicit reply address, else the IMAP user when it is an address. */
export function channelReplyTo(ch: { replyAddress?: string | null; imapUser?: string | null; imapEnabled?: boolean } | undefined): string | null {
  if (!ch) return null
  if (ch.replyAddress) return ch.replyAddress
  if (ch.imapEnabled && ch.imapUser && /^[^@\s]+@[^@\s]+$/.test(ch.imapUser)) return ch.imapUser
  return null
}

export async function sendRequestMail(o: {
  issueId: number
  kind: RequestMailKind
  authorId?: number | null
  body?: string
  statusName?: string
  mergedInto?: string
}): Promise<RequestMailResult> {
  const smtp = await getSmtpConfig()
  if (!smtp) {
    if (!warnedNoSmtp) { warnedNoSmtp = true; console.warn('[servicedesk-mail] SMTP is not configured, customer e-mail is skipped') }
    return { queued: 0, skipped: 'smtp' }
  }
  const row = await loadRequest(o.issueId)
  if (!row) return { queued: 0, skipped: 'not-a-request' }
  const { issue, req, desk } = row
  if (!desk.enabled) return { queued: 0, skipped: 'disabled' }
  if (o.kind === 'comment' && !desk.notifyCustomerComments) return { queued: 0, skipped: 'disabled' }
  if (o.kind === 'status' && !desk.notifyCustomerStatus) return { queued: 0, skipped: 'disabled' }

  // Customer side: requester and participants (never agents), active accounts with an address, not the author
  // Issue security: customers who cannot see the request (its level excludes them) get no mail either.
  const seeing = await usersWhoCanSee(issue.id, await customerSideUserIds(req))
  const ids = [...seeing]
  const users = await db.select().from(schema.users).where(inArray(schema.users.id, ids))
  const seen = new Set<string>()
  const recipients = users.filter((u) => {
    if (u.active === false || !u.email || u.id === o.authorId) return false
    const k = u.email.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (recipients.length === 0) return { queued: 0, skipped: 'no-recipients' }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sdOutboundMessages)
    .where(and(eq(schema.sdOutboundMessages.issueId, issue.id), gt(schema.sdOutboundMessages.createdAt, new Date(Date.now() - 3600_000))))
  if (Number(n) + recipients.length > MAX_MAILS_PER_REQUEST_HOUR) {
    console.warn(`[servicedesk-mail] rate limit reached for ${issue.issueKey}, mail skipped`)
    return { queued: 0, skipped: 'rate-limit' }
  }

  const [ch] = await db.select().from(schema.sdEmailChannels).where(eq(schema.sdEmailChannels.serviceDeskId, desk.id)).limit(1)
  const replyTo = channelReplyTo(ch)
  const [prev] = await db.select({ id: schema.sdOutboundMessages.messageId }).from(schema.sdOutboundMessages)
    .where(eq(schema.sdOutboundMessages.issueId, issue.id)).orderBy(desc(schema.sdOutboundMessages.id)).limit(1)
  const author = o.authorId
    ? (await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, o.authorId)).limit(1))[0]
    : undefined
  const webUrl = process.env.WEB_URL || 'http://localhost:3001'
  const domain = mailDomain(replyTo ?? smtp.from, webUrl)
  const body = o.body ? (o.body.length > MAX_BODY_CHARS ? `${o.body.slice(0, MAX_BODY_CHARS)}\n[...]` : o.body) : undefined

  for (const u of recipients) {
    const headers = buildThreadHeaders({
      issueKey: issue.issueKey, domain, token: randomBytes(8).toString('hex'), previousId: prev?.id, replyTo,
      autoGenerated: o.kind !== 'comment',
    })
    await db.insert(schema.sdOutboundMessages).values({ serviceDeskId: desk.id, issueId: issue.id, messageId: headers['Message-ID'] })
    await queueEmailWithHeaders(u.email, 'request-update', {
      kind: o.kind,
      subject: requestSubject(issue.issueKey, issue.summary),
      issueKey: issue.issueKey,
      summary: issue.summary,
      deskName: desk.name,
      authorName: author?.name ?? undefined,
      body,
      statusName: o.statusName,
      mergedInto: o.mergedInto,
      requestUrl: portalRequestUrl(webUrl, desk.slug, issue.issueKey),
      replyHint: !!replyTo,
    }, headers as unknown as Record<string, string>)
  }
  return { queued: recipients.length }
}

/** Public comment on a request by an agent. Best effort: failures are logged, never thrown. */
export async function notifyRequestComment(comment: { body: string; authorId: number | null; isInternal?: boolean | null }, issueId: number): Promise<void> {
  if (comment.isInternal) return // never mail internal notes
  try {
    await sendRequestMail({ issueId, kind: 'comment', authorId: comment.authorId, body: comment.body })
  } catch (e) {
    console.error('[servicedesk-mail] reply notification failed:', (e as Error)?.message)
  }
}

/** Status of a request changed (optionally with the transition comment). Mails according to the desk switches. */
export async function notifyRequestStatusChange(issueId: number, authorId: number | null, comment?: string): Promise<void> {
  try {
    const row = await loadRequest(issueId)
    if (!row) return
    const [status] = await db.select({ name: schema.statuses.name }).from(schema.statuses).where(eq(schema.statuses.id, row.issue.statusId)).limit(1)
    const r = row.desk.notifyCustomerStatus
      ? await sendRequestMail({ issueId, kind: 'status', authorId, statusName: status?.name, body: comment })
      : null
    if (!r && comment?.trim()) await sendRequestMail({ issueId, kind: 'comment', authorId, body: comment })
  } catch (e) {
    console.error('[servicedesk-mail] status notification failed:', (e as Error)?.message)
  }
}
