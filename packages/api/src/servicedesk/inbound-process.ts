/**
 * Turns one inbound e-mail into a request or a public comment. Shared by the HTTP gateway endpoint and the IMAP
 * poller so both channels behave identically: loop guard, threading (subject key, In-Reply-To / References),
 * sender provisioning, quote stripping and attachment storage with size limits.
 */
import { onCustomerReply, onRequestCreated } from './automation'
import { and, count, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { createIssue } from '../issues/service'
import { getDeskRole } from './service'
import { findUserByEmail, provisionUser } from './customers'
import { checkAttachmentPolicy } from '../settings/instance'
import { uploadFile, isAllowedMimeType, validateFileSize } from '../storage/service'
import { getSmtpConfig } from '../services/email'
import {
  extractIssueKey, normalizeAddress, sanitizeSubject, summaryFromSubject, detectLoop, cleanBody, isDomainAllowed,
} from './inbound-email'
import { issueKeyFromReferences, parseMessageIds } from './mail-threading'
import { channelReplyTo } from './outbound-mail'
import type { InboundAttachment, NormalizedMail } from './mime'
import {
  checkContent, maxAttachmentBytes, normalizeMime, safeExtension, sanitizeFileName, MAX_ATTACHMENTS_PER_REQUEST,
} from './upload-validation'

type Desk = typeof schema.serviceDesks.$inferSelect
type Channel = typeof schema.sdEmailChannels.$inferSelect

export type InboundOutcome = {
  status: 'created' | 'commented' | 'rejected'
  reason?: string
  issueId?: number
  key?: string
}
const reject = (reason: string): InboundOutcome => ({ status: 'rejected', reason })

/** Attachments handled per mail; the rest is dropped (and noted). */
export const MAX_INBOUND_ATTACHMENTS = 10


/** Only the request's customer or an explicit participant may thread by email. */
async function isRequesterOrParticipant(requestId: number, customerId: number, userId: number) {
  if (customerId === userId) return true
  const [p] = await db.select({ id: schema.requestParticipants.id }).from(schema.requestParticipants)
    .where(and(eq(schema.requestParticipants.requestId, requestId), eq(schema.requestParticipants.userId, userId))).limit(1)
  return !!p
}

/** Request key from the subject, else from our Message-IDs in In-Reply-To / References, else the outbound log. */
async function findRequestKey(desk: Desk, projectKey: string, subject: string, ids: string[]): Promise<string | null> {
  const fromSubject = extractIssueKey(subject, projectKey)
  if (fromSubject) return fromSubject
  const fromIds = issueKeyFromReferences(ids, projectKey)
  if (fromIds) return fromIds
  if (ids.length === 0) return null
  const [hit] = await db.select({ key: schema.issues.issueKey }).from(schema.sdOutboundMessages)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sdOutboundMessages.issueId))
    .where(and(eq(schema.sdOutboundMessages.serviceDeskId, desk.id), inArray(schema.sdOutboundMessages.messageId, ids))).limit(1)
  return hit?.key ?? null
}

/** Store customer attachments through the normal attachment storage; skipped files are counted, not fatal. */
export async function storeInboundAttachments(
  issue: { id: number; issueKey: string; projectId: number }, authorId: number, atts: InboundAttachment[],
): Promise<{ stored: number; skipped: number }> {
  if (atts.length === 0) return { stored: 0, skipped: 0 }
  const [project] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1)
  const [{ n }] = await db.select({ n: count() }).from(schema.attachments).where(eq(schema.attachments.issueId, issue.id))
  let existing = Number(n)
  let stored = 0
  let skipped = Math.max(0, atts.length - MAX_INBOUND_ATTACHMENTS)
  const max = maxAttachmentBytes()
  for (const a of atts.slice(0, MAX_INBOUND_ATTACHMENTS)) {
    try {
      const size = a.content.byteLength
      if (!project || size <= 0 || size > max || !validateFileSize(size) || existing >= MAX_ATTACHMENTS_PER_REQUEST) { skipped++; continue }
      const filename = sanitizeFileName(a.filename)
      if (!isAllowedMimeType(normalizeMime(a.contentType) || 'application/octet-stream')) { skipped++; continue }
      if (await checkAttachmentPolicy(size, filename, issue.projectId)) { skipped++; continue }
      const check = checkContent(a.contentType, a.content.subarray(0, 512))
      if (!check.ok || !isAllowedMimeType(check.mime)) { skipped++; continue }
      const up = await uploadFile(project.key, issue.issueKey, Buffer.from(a.content), `upload.${safeExtension(filename)}`, check.mime)
      await db.insert(schema.attachments).values({
        issueId: issue.id, filename, filesize: size, mimetype: check.mime, storageKey: up.storageKey, authorId,
      })
      existing++
      stored++
    } catch (e) {
      skipped++
      console.error('[servicedesk-inbound] attachment skipped:', (e as Error)?.name)
    }
  }
  return { stored, skipped }
}

async function tryComment(
  desk: Desk, projectKey: string, subject: string, from: string, body: string, ids: string[], atts: InboundAttachment[],
): Promise<InboundOutcome | null> {
  const key = await findRequestKey(desk, projectKey, subject, ids)
  if (!key) return null
  const sender = await findUserByEmail(from)
  if (!sender || sender.active === false) return null
  const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.issues.issueKey, key), eq(schema.serviceRequests.serviceDeskId, desk.id))).limit(1)
  if (!row) return null
  if (!(await isRequesterOrParticipant(row.req.id, row.req.customerId, sender.id))) return null // not theirs: treat as a new request
  if (!body && atts.length === 0) return reject('empty reply body')
  const [cm] = await db.insert(schema.comments).values({
    issueId: row.issue.id, body: body || '(attachment)', authorId: sender.id, isInternal: false,
  }).returning()
  const files = await storeInboundAttachments(row.issue, sender.id, atts)
  void onCustomerReply(row.issue.id) // reopen rules (best effort, never throws)
  try {
    const { notifyCommentAdded } = await import('../services/notifications')
    await notifyCommentAdded(cm, row.issue)
  } catch {
    console.error('[servicedesk-email] comment notification failed')
  }
  return { status: 'commented', issueId: row.issue.id, key, ...(files.skipped ? { reason: `${files.skipped} attachment(s) skipped` } : {}) }
}

async function resolveSender(desk: Desk, from: string, displayHint: string): Promise<{ id: number } | string> {
  const existing = await findUserByEmail(from)
  if (existing) {
    if (existing.active === false) return 'sender inactive'
    const role = await getDeskRole(existing, desk)
    if (role === 'none') {
      if (!desk.publicSignup) return 'sender not a customer of this desk'
      await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: desk.id, userId: existing.id }).onConflictDoNothing()
    }
    return { id: existing.id }
  }
  if (!desk.publicSignup) return 'unknown sender and public signup disabled'
  const u = await provisionUser(from, displayHint)
  if (!u) return 'could not provision sender'
  await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: desk.id, userId: u.id }).onConflictDoNothing()
  return { id: u.id }
}

async function createRequest(
  desk: Desk, ch: Channel, projectKey: string, from: string, fromRaw: string, subject: string, body: string, atts: InboundAttachment[],
): Promise<InboundOutcome> {
  if (!ch.defaultRequestTypeId) return reject('no default request type configured')
  const [rt] = await db.select().from(schema.requestTypes).where(and(
    eq(schema.requestTypes.id, ch.defaultRequestTypeId), eq(schema.requestTypes.serviceDeskId, desk.id), eq(schema.requestTypes.enabled, true),
  )).limit(1)
  if (!rt) return reject('default request type unavailable')
  if (!isDomainAllowed(from, ch.allowedSenderDomains)) return reject('sender domain not allowed')

  const hint = /^\s*"?([^"<]{1,100}?)"?\s*</.exec(fromRaw)?.[1]?.trim() ?? ''
  const sender = await resolveSender(desk, from, hint)
  if (typeof sender === 'string') return reject(sender)

  const issue = await createIssue({
    projectId: desk.projectId,
    issueTypeId: rt.issueTypeId,
    priorityId: rt.defaultPriorityId ?? undefined,
    summary: summaryFromSubject(subject, projectKey),
    description: body || (atts.length ? '(see attachments)' : ''),
  }, sender.id)
  const [row] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1)
  await db.insert(schema.serviceRequests).values({
    issueId: row.id, serviceDeskId: desk.id, requestTypeId: rt.id, customerId: sender.id, channel: 'email', fieldValues: {},
  })
  await onRequestCreated(row.id) // auto-categorisation rules
  const files = await storeInboundAttachments({ id: row.id, issueKey: issue.key, projectId: desk.projectId }, sender.id, atts)
  return { status: 'created', issueId: row.id, key: issue.key, ...(files.skipped ? { reason: `${files.skipped} attachment(s) skipped` } : {}) }
}

/** Addresses that are ours: mail from them is a loop, never a customer. */
export async function ownAddresses(ch: Channel): Promise<string[]> {
  const smtp = await getSmtpConfig().catch(() => null)
  return [channelReplyTo({ ...ch, imapEnabled: true }), ch.replyAddress, ch.imapUser, smtp?.from]
    .map((a) => (a ? normalizeAddress(a) : null))
    .filter((a): a is string => !!a)
}

/** Process one message. Never throws for bad input: unusable mail is a `rejected` outcome. */
export async function processInboundMail(desk: Desk, ch: Channel, mail: NormalizedMail): Promise<InboundOutcome> {
  const from = normalizeAddress(mail.from)
  if (!from) return reject('invalid sender address')
  const subject = sanitizeSubject(mail.subject)

  const loop = detectLoop({
    headers: mail.headers, subject, from, messageId: mail.messageId, ownAddresses: await ownAddresses(ch),
  })
  if (loop) return reject(`auto-reply or bulk mail (${loop})`)

  const [project] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, desk.projectId)).limit(1)
  const body = cleanBody(mail.text)
  const ids = [...mail.inReplyTo, ...mail.references, ...parseMessageIds(mail.headers['in-reply-to']), ...parseMessageIds(mail.headers['references'])]
  return (await tryComment(desk, project.key, subject, from, body, ids, mail.attachments)) ??
    (await createRequest(desk, ch, project.key, from, mail.from, subject, body, mail.attachments))
}
