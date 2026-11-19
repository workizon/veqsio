/**
 * Merge and link service requests of one desk.
 *
 * Merge: comments, attachments and participants of the source move to the target (with an internal note on the
 * target), the source is linked "duplicates" -> target, closed with resolution Duplicate and its customer side is told
 * through the normal customer mail path. Everything that changes data runs in one transaction.
 */
import { issueVisibleSql } from '../security/issue-security'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { normalizeCategory } from '../workflow/transition-meta'
import { getAvailableTransitions } from '../workflow/engine'
import { invalidateIssueCache } from '../middleware/cache'
import { publishIssueById } from '../realtime/publish'
import { sendRequestMail } from './outbound-mail'

export class DeskActionError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message) }
}

type Desk = typeof schema.serviceDesks.$inferSelect
type Agent = { id: number; displayName: string | null; username: string }

async function loadDeskRequest(desk: Desk, key: string, viewerId: number) {
  const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.issues.issueKey, key), eq(schema.serviceRequests.serviceDeskId, desk.id), issueVisibleSql(viewerId))).limit(1)
  return row ?? null
}

async function duplicateLinkTypeId(): Promise<number> {
  const [t] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.name, 'Duplicate')).limit(1)
  if (t) return t.id
  const [c] = await db.insert(schema.linkTypes).values({ name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }).returning()
  return c.id
}

async function duplicateResolutionId(): Promise<number> {
  const [r] = await db.select().from(schema.resolutions).where(eq(schema.resolutions.name, 'Duplicate')).limit(1)
  if (r) return r.id
  const [c] = await db.insert(schema.resolutions).values({ name: 'Duplicate', description: 'Duplicate of another request' }).returning()
  return c.id
}

/** A done-category status the source can be closed with: prefer one its workflow can reach, else any done status. */
async function closedStatusId(issueId: number, agentId: number): Promise<number> {
  try {
    const ts = await getAvailableTransitions(issueId, agentId)
    const done = ts.find((t: any) => normalizeCategory(t.to?.statusCategory) === 'done')
    if (done) return done.to.id as number
  } catch { /* fall back below */ }
  const dones = (await db.select().from(schema.statuses)).filter((s) => normalizeCategory(s.category) === 'done')
  const pick = dones.find((s) => /^(closed|done|resolved)$/i.test(s.name)) ?? dones[0]
  if (!pick) throw new DeskActionError(400, 'No done status is configured to close the duplicate')
  return pick.id
}

export interface MergeResult { source: string; target: string; movedComments: number; movedAttachments: number; addedParticipants: number }

export async function mergeRequests(desk: Desk, agent: Agent, sourceKey: string, targetKey: string, note?: string): Promise<MergeResult> {
  if (sourceKey === targetKey) throw new DeskActionError(400, 'A request cannot be merged into itself')
  const [source, target] = await Promise.all([loadDeskRequest(desk, sourceKey, agent.id), loadDeskRequest(desk, targetKey, agent.id)])
  if (!source) throw new DeskActionError(404, 'Request not found')
  if (!target) throw new DeskActionError(400, 'Target request not found in this service desk')
  if (source.issue.resolutionId || source.issue.resolvedAt) throw new DeskActionError(409, 'The request is already closed')

  const dupResolution = await duplicateResolutionId()
  if (target.issue.resolutionId === dupResolution) throw new DeskActionError(409, 'The target was itself closed as a duplicate, merge into the original instead')

  const [linkTypeId, closedId] = [await duplicateLinkTypeId(), await closedStatusId(source.issue.id, agent.id)]
  const agentName = agent.displayName || agent.username

  const result = await db.transaction(async (tx) => {
    // Lock both requests in id order so concurrent opposite merges cannot deadlock or create a cycle.
    const ids = [source.issue.id, target.issue.id].sort((a, b) => a - b)
    await tx.select({ id: schema.issues.id }).from(schema.issues).where(inArray(schema.issues.id, ids)).orderBy(schema.issues.id).for('update')
    const [fresh] = await tx.select({ resolvedAt: schema.issues.resolvedAt, resolutionId: schema.issues.resolutionId })
      .from(schema.issues).where(eq(schema.issues.id, source.issue.id)).limit(1)
    if (fresh?.resolutionId || fresh?.resolvedAt) throw new DeskActionError(409, 'The request is already closed')

    const movedComments = (await tx.update(schema.comments).set({ issueId: target.issue.id })
      .where(eq(schema.comments.issueId, source.issue.id)).returning({ id: schema.comments.id })).length
    const movedAttachments = (await tx.update(schema.attachments).set({ issueId: target.issue.id })
      .where(eq(schema.attachments.issueId, source.issue.id)).returning({ id: schema.attachments.id })).length

    // The source's customer side can follow the conversation on the target
    const sourceParticipants = await tx.select({ userId: schema.requestParticipants.userId }).from(schema.requestParticipants)
      .where(eq(schema.requestParticipants.requestId, source.req.id))
    const wanted = new Set<number>([source.req.customerId, ...sourceParticipants.map((p) => p.userId)])
    wanted.delete(target.req.customerId)
    let addedParticipants = 0
    if (wanted.size) {
      addedParticipants = (await tx.insert(schema.requestParticipants)
        .values([...wanted].map((userId) => ({ requestId: target.req.id, userId }))).onConflictDoNothing()
        .returning({ id: schema.requestParticipants.id })).length
    }

    // source "duplicates" target: the row stores the target as issueId (shows the inward text) and the source as linked issue
    const [hasLink] = await tx.select({ id: schema.issueLinks.id }).from(schema.issueLinks).where(and(
      eq(schema.issueLinks.issueId, target.issue.id), eq(schema.issueLinks.linkedIssueId, source.issue.id), eq(schema.issueLinks.linkTypeId, linkTypeId),
    )).limit(1)
    if (!hasLink) await tx.insert(schema.issueLinks).values({ issueId: target.issue.id, linkedIssueId: source.issue.id, linkTypeId })

    // Close the source as Duplicate
    const [oldStatus] = await tx.select().from(schema.statuses).where(eq(schema.statuses.id, source.issue.statusId)).limit(1)
    const [newStatus] = await tx.select().from(schema.statuses).where(eq(schema.statuses.id, closedId)).limit(1)
    await tx.update(schema.issues).set({ statusId: closedId, resolutionId: dupResolution, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.issues.id, source.issue.id))
    await tx.insert(schema.issueHistory).values([
      { issueId: source.issue.id, fieldName: 'status', oldValue: oldStatus?.name ?? null, newValue: newStatus?.name ?? null, authorId: agent.id },
      { issueId: source.issue.id, fieldName: 'resolution', oldValue: null, newValue: 'Duplicate', authorId: agent.id },
    ])

    const detail = `${movedComments} comment(s), ${movedAttachments} attachment(s)${addedParticipants ? `, ${addedParticipants} participant(s)` : ''}`
    await tx.insert(schema.comments).values([
      {
        issueId: target.issue.id, authorId: agent.id, isInternal: true,
        body: `Merged from ${source.issue.issueKey} by ${agentName}: ${detail} moved here.${note?.trim() ? `\n\n${note.trim()}` : ''}`,
      },
      {
        issueId: source.issue.id, authorId: agent.id, isInternal: false,
        body: `This request was merged into ${target.issue.issueKey} and closed as a duplicate. Please follow ${target.issue.issueKey} for updates.`,
      },
    ])
    return { movedComments, movedAttachments, addedParticipants }
  })

  await invalidateIssueCache(source.issue.issueKey).catch(() => {})
  await invalidateIssueCache(target.issue.issueKey).catch(() => {})
  publishIssueById('issue.updated', source.issue.id, agent.id)
  publishIssueById('issue.updated', target.issue.id, agent.id)
  // Tell the source's customer side through the shared mail path (best effort, respects SMTP / desk settings)
  try {
    await sendRequestMail({ issueId: source.issue.id, kind: 'merged', authorId: agent.id, mergedInto: target.issue.issueKey })
  } catch (e) {
    console.error('[servicedesk-merge] customer notice failed:', (e as Error)?.message)
  }
  return { source: source.issue.issueKey, target: target.issue.issueKey, ...result }
}

/** Link two requests of the desk. `direction` is relative to `sourceKey`: outward = "source <outward text> target". */
export async function linkRequests(
  desk: Desk, sourceKey: string, targetKey: string, linkTypeId: number, direction: 'outward' | 'inward', viewerId: number,
): Promise<{ id: number }> {
  if (sourceKey === targetKey) throw new DeskActionError(400, 'A request cannot be linked to itself')
  const [a, b] = await Promise.all([loadDeskRequest(desk, sourceKey, viewerId), loadDeskRequest(desk, targetKey, viewerId)])
  if (!a) throw new DeskActionError(404, 'Request not found')
  if (!b) throw new DeskActionError(400, 'Target request not found in this service desk')
  const [lt] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, linkTypeId)).limit(1)
  if (!lt) throw new DeskActionError(400, 'Unknown link type')
  // issue_links(issueId, linkedIssueId): the linked issue reads the outward text ("duplicates"), issueId the inward one
  const [issueId, linkedIssueId] = direction === 'outward' ? [b.issue.id, a.issue.id] : [a.issue.id, b.issue.id]
  const [dup] = await db.select({ id: schema.issueLinks.id }).from(schema.issueLinks).where(and(
    eq(schema.issueLinks.linkTypeId, linkTypeId), sql`(${schema.issueLinks.issueId}, ${schema.issueLinks.linkedIssueId}) in ((${issueId}, ${linkedIssueId}), (${linkedIssueId}, ${issueId}))`,
  )).limit(1)
  if (dup) throw new DeskActionError(409, 'These requests are already linked with this type')
  const [row] = await db.insert(schema.issueLinks).values({ issueId, linkedIssueId, linkTypeId }).returning({ id: schema.issueLinks.id })
  await invalidateIssueCache(a.issue.issueKey).catch(() => {})
  await invalidateIssueCache(b.issue.issueKey).catch(() => {})
  return row
}
