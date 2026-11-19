/** Database operations for Intake / triage (settings, items, the triage state machine, requester emails). */
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { createIssue } from '../issues/service'
import { invalidateIssueCache } from '../middleware/cache'
import { checkProjectPermission } from '../middleware/permissions'
import { notifyIssueCreated } from '../services/notifications'
import { queueEmails } from '../services/email'
import { getRedisClient } from '../services/redis-client'
const redis = getRedisClient()
import { publishIssue } from '../realtime/publish'
import {
  canApply, generateSlug, issueDescription, parseIssueRef, cleanText, LIMITS,
  type CleanSubmission, type IntakeAction, type IntakeSource, type IntakeStatus,
} from './helpers'

export type Settings = typeof schema.intakeSettings.$inferSelect
export type Item = typeof schema.intakeItems.$inferSelect

export class IntakeError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message) }
}

/* ------------------------------ settings ------------------------------ */

export async function getSettings(projectId: number): Promise<Settings | undefined> {
  return (await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId)).limit(1))[0]
}

export async function getSettingsBySlug(slug: string): Promise<(Settings & { projectName: string }) | undefined> {
  const [row] = await db.select({ s: schema.intakeSettings, projectName: schema.projects.name })
    .from(schema.intakeSettings).innerJoin(schema.projects, eq(schema.projects.id, schema.intakeSettings.projectId))
    .where(eq(schema.intakeSettings.slug, slug)).limit(1)
  return row ? { ...row.s, projectName: row.projectName } : undefined
}

/** The settings row, created with a fresh slug on first use. */
export async function ensureSettings(projectId: number): Promise<Settings> {
  const existing = await getSettings(projectId)
  if (existing) return existing
  const [row] = await db.insert(schema.intakeSettings).values({ projectId, slug: generateSlug() }).onConflictDoNothing().returning()
  return row ?? (await getSettings(projectId))!
}

export async function isServiceDeskProject(projectId: number): Promise<boolean> {
  const [d] = await db.select({ id: schema.serviceDesks.id }).from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, projectId)).limit(1)
  return !!d
}

/* ------------------------------ items ------------------------------ */

/** Snoozed items whose date has passed are pending again. Idempotent, cheap (indexed), safe to call on every read. */
export async function wakeSnoozed(projectId?: number): Promise<number> {
  const due = and(eq(schema.intakeItems.status, 'snoozed'), lte(schema.intakeItems.snoozedUntil, new Date()))
  const rows = await db.update(schema.intakeItems)
    .set({ status: 'pending', snoozedUntil: null, decidedBy: null, decidedAt: null, decisionReason: null, updatedAt: new Date() })
    .where(projectId === undefined ? due : and(due, eq(schema.intakeItems.projectId, projectId)))
    .returning({ id: schema.intakeItems.id })
  return rows.length
}

/** Open (pending) items per project cap for anonymous submissions. */
export const PUBLIC_PENDING_CAP = Number(process.env.INTAKE_PUBLIC_PENDING_CAP) || 2000

export async function countPendingFromSource(projectId: number, source: IntakeSource): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.intakeItems)
    .where(and(eq(schema.intakeItems.projectId, projectId), eq(schema.intakeItems.status, 'pending'), eq(schema.intakeItems.source, source)))
  return r?.n ?? 0
}

export async function createItem(
  projectId: number,
  data: CleanSubmission & { source: IntakeSource; requesterUserId?: number | null; sourceRef?: string | null },
): Promise<Item | null> {
  const [row] = await db.insert(schema.intakeItems).values({
    projectId, title: data.title, description: data.description,
    requesterName: data.requesterName, requesterEmail: data.requesterEmail, requesterUserId: data.requesterUserId ?? null,
    source: data.source, status: 'pending', sourceRef: data.sourceRef ?? null,
  }).onConflictDoNothing().returning()
  if (row) void notifyTriagers(row)
  return row ?? null // null: the external message id was already processed
}

/** Emails the project lead about a new submission (rate limited per project). Never throws. */
async function notifyTriagers(item: Item) {
  try {
    const [settings] = await db.select({ on: schema.intakeSettings.notifyLead }).from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, item.projectId)).limit(1)
    if (settings && settings.on === false) return
    const [row] = await db.select({ name: schema.projects.name, key: schema.projects.projectKey, email: schema.users.email })
      .from(schema.projects).leftJoin(schema.users, eq(schema.users.id, schema.projects.leadId)).where(eq(schema.projects.id, item.projectId)).limit(1)
    if (!row?.email) return
    // One email per project per 10 minutes, so a flood of submissions cannot flood the lead's inbox.
    const gate = await redis.set(`veqsio:intake:notified:${item.projectId}`, '1', 'EX', 600, 'NX')
    const first = gate === 'OK'
    if (!first) return
    const base = (process.env.BASE_URL || process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '')
    await queueEmails([row.email], 'intake-new', { projectName: row.name, title: item.title, source: item.source, link: `${base}/projects/${row.key}/intake`, more: '1' })
  } catch (e) {
    console.error('[intake] triager notification failed:', (e as Error)?.name)
  }
}

export async function loadItem(projectId: number, id: number): Promise<Item | undefined> {
  return (await db.select().from(schema.intakeItems)
    .where(and(eq(schema.intakeItems.id, id), eq(schema.intakeItems.projectId, projectId))).limit(1))[0]
}

export interface ItemView {
  id: number; title: string; description: string; source: string; status: string
  requester: { name: string | null; email: string | null; userId: number | null }
  decidedBy: number | null; decidedAt: Date | null; decisionReason: string | null; snoozedUntil: Date | null
  acceptedIssue: { id: number; key: string } | null; duplicateOf: { id: number; key: string } | null
  createdAt: Date; updatedAt: Date
}

export async function viewItems(items: Item[]): Promise<ItemView[]> {
  const ids = [...new Set(items.flatMap((i) => [i.acceptedIssueId, i.duplicateOfIssueId]).filter((x): x is number => !!x))]
  const keys = new Map<number, string>()
  if (ids.length) {
    for (const r of await db.select({ id: schema.issues.id, key: schema.issues.issueKey }).from(schema.issues).where(inArray(schema.issues.id, ids))) keys.set(r.id, r.key)
  }
  const ref = (id: number | null) => (id && keys.has(id) ? { id, key: keys.get(id)! } : null)
  return items.map((i) => ({
    id: i.id, title: i.title, description: i.description, source: i.source, status: i.status,
    requester: { name: i.requesterName, email: i.requesterEmail, userId: i.requesterUserId },
    decidedBy: i.decidedBy, decidedAt: i.decidedAt, decisionReason: i.decisionReason, snoozedUntil: i.snoozedUntil,
    acceptedIssue: ref(i.acceptedIssueId), duplicateOf: ref(i.duplicateOfIssueId), createdAt: i.createdAt, updatedAt: i.updatedAt,
  }))
}

export async function statusCounts(projectId: number): Promise<Record<IntakeStatus, number>> {
  const rows = await db.select({ status: schema.intakeItems.status, n: sql<number>`count(*)::int` }).from(schema.intakeItems)
    .where(eq(schema.intakeItems.projectId, projectId)).groupBy(schema.intakeItems.status)
  const out: Record<IntakeStatus, number> = { pending: 0, snoozed: 0, accepted: 0, declined: 0, duplicate: 0 }
  for (const r of rows) if (r.status in out) out[r.status as IntakeStatus] = r.n
  return out
}

/* ------------------------------ triage ------------------------------ */

export interface ActionParams {
  issueTypeId?: number; priorityId?: number | null; assigneeId?: number | null; summary?: string; note?: string
  reason?: string; until?: Date; issue?: unknown
}

type Actor = typeof schema.users.$inferSelect

/** Tells the requester about the decision. Never throws: a mail problem must not undo a triage decision. */
async function notifyRequester(item: Item, decision: 'accepted' | 'declined', reason: string | null, issueKey: string) {
  if (!item.requesterEmail) return
  try {
    const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, item.projectId)).limit(1)
    await queueEmails([item.requesterEmail], 'intake-decided', {
      projectName: project?.name ?? '', title: item.title, decision, requesterName: item.requesterName ?? '',
      reason: reason ?? '', issueKey: decision === 'accepted' ? issueKey : '',
    })
  } catch (e) {
    console.error('[intake] requester notification failed:', (e as Error)?.name)
  }
}

async function resolveIssue(projectId: number, raw: unknown): Promise<{ id: number; key: string }> {
  const ref = parseIssueRef(raw)
  if (!ref) throw new IntakeError(400, 'issue must be an issue key such as ABC-12')
  const [row] = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, projectId: schema.issues.projectId }).from(schema.issues)
    .where('key' in ref ? eq(schema.issues.issueKey, ref.key) : eq(schema.issues.id, ref.id)).limit(1)
  // Only issues of the same project, so a triager cannot probe issues of projects they cannot see.
  if (!row || row.projectId !== projectId) throw new IntakeError(400, 'Unknown issue in this project')
  return { id: row.id, key: row.key }
}

async function validateAcceptTarget(projectId: number, p: ActionParams): Promise<number> {
  if (!p.issueTypeId) throw new IntakeError(400, 'issueTypeId is required')
  const [type] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, p.issueTypeId)).limit(1)
  if (!type || type.isSubtask) throw new IntakeError(400, 'Unknown or unsupported issue type')
  const [assoc] = await db.select({ schemeId: schema.issueTypeSchemeAssociations.schemeId }).from(schema.issueTypeSchemeAssociations)
    .where(eq(schema.issueTypeSchemeAssociations.projectId, projectId)).limit(1)
  if (assoc) {
    const [ok] = await db.select({ id: schema.issueTypeSchemeItems.issueTypeId }).from(schema.issueTypeSchemeItems)
      .where(and(eq(schema.issueTypeSchemeItems.schemeId, assoc.schemeId), eq(schema.issueTypeSchemeItems.issueTypeId, type.id))).limit(1)
    if (!ok) throw new IntakeError(400, 'Issue type is not available in this project')
  }
  if (p.priorityId) {
    const [pr] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(schema.priorities.id, p.priorityId)).limit(1)
    if (!pr) throw new IntakeError(400, 'Unknown priority')
  }
  if (p.assigneeId) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, p.assigneeId)).limit(1)
    if (!u || u.active === false || !(await checkProjectPermission(u, projectId, 'ASSIGNABLE_USER'))) throw new IntakeError(400, 'The assignee cannot be assigned issues in this project')
  }
  return type.id
}

/**
 * Applies one triage action. The status change is a single conditional UPDATE, so two triagers (or a retried bulk
 * request) can never both decide the same item; the loser gets a 409.
 */
export async function applyAction(item: Item, action: IntakeAction, actor: Actor, p: ActionParams): Promise<ItemView> {
  if (!canApply(item.status as IntakeStatus, action)) throw new IntakeError(409, `A ${item.status} item cannot be ${action === 'reopen' ? 'reopened' : action + 'ed'}`)
  const now = new Date()
  const from = item.status
  const claim = async (set: Partial<typeof schema.intakeItems.$inferInsert>) => {
    const [row] = await db.update(schema.intakeItems).set({ ...set, updatedAt: now })
      .where(and(eq(schema.intakeItems.id, item.id), eq(schema.intakeItems.status, from))).returning()
    if (!row) throw new IntakeError(409, 'This item was changed by someone else, reload and try again')
    return row
  }
  const decided = { decidedBy: actor.id, decidedAt: now }
  const reason = p.reason !== undefined ? cleanText(p.reason, LIMITS.reason) || null : null

  switch (action) {
    case 'decline': {
      const row = await claim({ status: 'declined', ...decided, decisionReason: reason, snoozedUntil: null })
      await notifyRequester(row, 'declined', reason, '')
      return (await viewItems([row]))[0]
    }
    case 'snooze': {
      if (!p.until) throw new IntakeError(400, 'until is required')
      const row = await claim({ status: 'snoozed', ...decided, decisionReason: reason, snoozedUntil: p.until })
      return (await viewItems([row]))[0]
    }
    case 'duplicate': {
      const dup = await resolveIssue(item.projectId, p.issue)
      const row = await claim({ status: 'duplicate', ...decided, decisionReason: reason, duplicateOfIssueId: dup.id, snoozedUntil: null })
      return (await viewItems([row]))[0]
    }
    case 'reopen': {
      const row = await claim({ status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, snoozedUntil: null, duplicateOfIssueId: null })
      return (await viewItems([row]))[0]
    }
    case 'accept': {
      const issueTypeId = await validateAcceptTarget(item.projectId, p)
      const claimed = await claim({ status: 'accepted', ...decided, decisionReason: reason, snoozedUntil: null })
      try {
        const summary = cleanText(p.summary, 255, false) || item.title
        const issue = await createIssue({
          projectId: item.projectId, issueTypeId, priorityId: p.priorityId ?? undefined, assigneeId: p.assigneeId ?? undefined,
          summary, description: issueDescription(item, p.note),
        }, actor.id)
        const [{ id }] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1)
        const [row] = await db.update(schema.intakeItems).set({ acceptedIssueId: id, updatedAt: new Date() })
          .where(eq(schema.intakeItems.id, item.id)).returning()
        await invalidateIssueCache()
        publishIssue('issue.created', issue, actor.id)
        try { await notifyIssueCreated(issue) } catch (e) { console.error('[intake] issue notification failed:', (e as Error)?.name) }
        await notifyRequester(claimed, 'accepted', reason, issue.key)
        return (await viewItems([row]))[0]
      } catch (e) {
        // The issue could not be created: put the item back so it is not lost.
        await db.update(schema.intakeItems)
          .set({ status: from, decidedBy: item.decidedBy, decidedAt: item.decidedAt, decisionReason: item.decisionReason, snoozedUntil: item.snoozedUntil, updatedAt: new Date() })
          .where(eq(schema.intakeItems.id, item.id))
        throw new IntakeError(400, (e as Error).message || 'Failed to create the issue')
      }
    }
  }
}
