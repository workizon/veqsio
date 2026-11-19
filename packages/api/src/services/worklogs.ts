/**
 * The one place that creates, changes and deletes worklogs. The REST routes and modules (e.g. Timesheets) both go
 * through here, so rules (veto hooks, issue time-spent recalculation) apply everywhere and there is no second store.
 */
import { eq } from 'drizzle-orm'
import { worklogs, issues } from '@veqsio/db'
import { db } from '../db'
import { runWorklogGuards } from '../modules/hooks'

export class WorklogError extends Error {
  constructor(public readonly status: 403 | 404 | 409 | 423, message: string) {
    super(message)
    this.name = 'WorklogError'
  }
}

export type WorklogRow = typeof worklogs.$inferSelect
export interface WorklogActor { id: number; displayName?: string | null; email?: string | null }

export async function recalcIssueTimeSpent(issueId: number): Promise<void> {
  const rows = await db.select({ s: worklogs.timeSpentSeconds }).from(worklogs).where(eq(worklogs.issueId, issueId))
  const total = rows.reduce((sum, w) => sum + (w.s || 0), 0)
  await db.update(issues).set({ timeSpent: total }).where(eq(issues.id, issueId))
}

async function guard(change: Parameters<typeof runWorklogGuards>[0]) {
  const veto = await runWorklogGuards(change)
  if (veto) throw new WorklogError(veto.status, veto.message)
}

export async function createWorklog(input: {
  issueKey: string
  actor: WorklogActor | undefined
  description?: string | null
  timeSpentSeconds: number
  started?: Date
}): Promise<WorklogRow> {
  const [issue] = await db.select({ id: issues.id }).from(issues).where(eq(issues.issueKey, input.issueKey)).limit(1)
  if (!issue) throw new WorklogError(404, 'Issue not found')
  const started = input.started ?? new Date()
  await guard({
    action: 'create', worklogId: null, issueId: issue.id, issueKey: input.issueKey,
    authorId: input.actor?.id ?? null, actorId: input.actor?.id ?? null, started, previousStarted: null,
  })
  const [wl] = await db.insert(worklogs).values({
    issueId: issue.id,
    issueKey: input.issueKey,
    authorId: input.actor?.id,
    authorName: input.actor?.displayName || input.actor?.email || 'Anonymous',
    authorEmail: input.actor?.email ?? undefined,
    description: input.description,
    timeSpentSeconds: input.timeSpentSeconds,
    started,
  }).returning()
  await recalcIssueTimeSpent(issue.id)
  return wl
}

export async function updateWorklog(id: number, actor: WorklogActor | undefined, patch: {
  description?: string
  timeSpentSeconds?: number
  started?: Date
}): Promise<WorklogRow> {
  const [existing] = await db.select().from(worklogs).where(eq(worklogs.id, id)).limit(1)
  if (!existing) throw new WorklogError(404, 'Worklog not found')
  const started = patch.started ?? existing.started
  await guard({
    action: 'update', worklogId: id, issueId: existing.issueId, issueKey: existing.issueKey,
    authorId: existing.authorId, actorId: actor?.id ?? null, started, previousStarted: existing.started,
  })
  const [wl] = await db.update(worklogs).set({
    description: patch.description,
    timeSpentSeconds: patch.timeSpentSeconds,
    started,
    updatedAt: new Date(),
  }).where(eq(worklogs.id, id)).returning()
  await recalcIssueTimeSpent(existing.issueId)
  return wl
}

export async function deleteWorklog(id: number, actor: WorklogActor | undefined): Promise<void> {
  const [existing] = await db.select().from(worklogs).where(eq(worklogs.id, id)).limit(1)
  if (!existing) throw new WorklogError(404, 'Worklog not found')
  await guard({
    action: 'delete', worklogId: id, issueId: existing.issueId, issueKey: existing.issueKey,
    authorId: existing.authorId, actorId: actor?.id ?? null, started: existing.started, previousStarted: existing.started,
  })
  await db.delete(worklogs).where(eq(worklogs.id, id))
  await recalcIssueTimeSpent(existing.issueId)
}
