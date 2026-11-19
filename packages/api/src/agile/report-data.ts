/**
 * Data loading shared by the agile report routes: issues with their status history (ReportIssue), and the same
 * issues with the intervals during which they belonged to a sprint, version or epic, derived from issue_history
 * (`Sprint`, `fixVersions` and `parent` rows) plus `sprint_issues.added_at`. No second history model.
 */
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { checkProjectPermission, getBrowsableProjectIds } from '../middleware/permissions'
import { issueVisibleSql } from '../security/issue-security'
import { pointsByIssue } from './points'
import { reportCategory, isCancelled } from '../workflow/status-groups'
import { sizeFor, type Category, type CategoryOf, type ReportIssue, type ReportUnit } from '../reports/agile'
import { intervalsFromEvents, type MembershipEvent, type ScopedIssue } from '../reports/burnup'

type Board = typeof schema.boards.$inferSelect
type User = typeof schema.users.$inferSelect

const MAX_SCOPE_ISSUES = 5000

export async function categoryOf(): Promise<CategoryOf> {
  const rows = await db.select().from(schema.statuses)
  const m = new Map(rows.map((s) => [s.name, reportCategory(s.category) as Category]))
  return (name) => m.get(name) ?? 'todo'
}

/** `viewerId`: leave out issues whose security level the viewer is not a member of (always pass it for user-facing reports). */
export async function loadIssues(issueIds: number[], unit: ReportUnit, viewerId?: number): Promise<ReportIssue[]> {
  if (issueIds.length === 0) return []
  const [issues, history, statuses, points] = await Promise.all([
    db.select().from(schema.issues).where(viewerId === undefined ? inArray(schema.issues.id, issueIds) : and(inArray(schema.issues.id, issueIds), issueVisibleSql(viewerId))),
    db.select().from(schema.issueHistory)
      .where(and(inArray(schema.issueHistory.issueId, issueIds), eq(schema.issueHistory.fieldName, 'status')))
      .orderBy(asc(schema.issueHistory.createdAt)),
    db.select().from(schema.statuses),
    unit === 'points' ? pointsByIssue(issueIds) : Promise.resolve(new Map<number, number>()),
  ])
  const statusName = new Map(statuses.map((s) => [s.id, s.name]))
  // Cancelled issues are out of scope for burndown, velocity and flow reports (neither completed nor outstanding).
  const cancelledStatus = new Set(statuses.filter((s) => isCancelled(s.category)).map((s) => s.id))
  // Group history by issue once (it used to be filtered per issue: O(issues x history), ~170 ms for 5000 issues).
  const historyByIssue = new Map<number, typeof history>()
  for (const h of history) {
    const list = historyByIssue.get(h.issueId)
    if (list) list.push(h)
    else historyByIssue.set(h.issueId, [h])
  }
  return issues.filter((i) => !cancelledStatus.has(i.statusId)).map((i) => {
    const own = historyByIssue.get(i.id) ?? []
    const changes = own.filter((h) => h.newValue)
      .map((h) => ({ at: h.createdAt!.getTime(), to: h.newValue! }))
    // Initial status: the "from" of the first change, otherwise the current one.
    const firstChange = own[0]
    const initialStatus = firstChange?.oldValue ?? statusName.get(i.statusId) ?? 'To Do'
    return {
      id: i.id, key: i.issueKey, summary: i.summary, createdAt: i.createdAt!.getTime(), initialStatus, changes,
      flagged: i.flagged === true,
      // pointsByIssue merges the issues.story_points column with the legacy "Story Points" custom field
      ...sizeFor(unit, { timeEstimate: i.timeEstimate, storyPoints: points.get(i.id) ?? i.storyPoints }),
    }
  })
}

export async function boardGuard(c: any): Promise<Board | null> {
  const id = Number(c.req.param('boardId'))
  if (!Number.isInteger(id)) return null
  const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1)
  if (!board) return null
  if (!(await checkProjectPermission(c.get('user'), board.projectId, 'BROWSE_PROJECTS'))) return null
  return board
}

export const unitOf = (c: any): ReportUnit => {
  const u = c.req.query('unit')
  return u === 'hours' || u === 'points' ? u : 'issues'
}

export async function sprintIssueIds(sprintId: number, viewerId?: number) {
  if (viewerId === undefined) {
    return (await db.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, sprintId))).map((r) => r.id)
  }
  return (await db.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sprintIssues.issueId))
    .where(and(eq(schema.sprintIssues.sprintId, sprintId), issueVisibleSql(viewerId)))).map((r) => r.id)
}

/* ---------------- Scope membership ---------------- */

interface RawEvent { issueId: number; at: number; old: string | null; next: string | null }

async function historyRows(field: string, issueIds: number[]): Promise<Map<number, RawEvent[]>> {
  const out = new Map<number, RawEvent[]>()
  if (issueIds.length === 0) return out
  const rows = await db.select().from(schema.issueHistory)
    .where(and(inArray(schema.issueHistory.issueId, issueIds), eq(schema.issueHistory.fieldName, field)))
    .orderBy(asc(schema.issueHistory.createdAt))
  for (const r of rows) {
    const e: RawEvent = { issueId: r.issueId, at: r.createdAt!.getTime(), old: r.oldValue, next: r.newValue }
    const list = out.get(r.issueId)
    if (list) list.push(e)
    else out.set(r.issueId, [e])
  }
  return out
}

/** Issue ids with a `field` history row whose old or new value mentions `needle` (a candidate list; matched exactly later). */
async function candidatesFromHistory(field: string, needle: string): Promise<number[]> {
  const like = `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const rows = await db.select({ id: schema.issueHistory.issueId }).from(schema.issueHistory)
    .where(and(eq(schema.issueHistory.fieldName, field), or(ilike(schema.issueHistory.oldValue, like), ilike(schema.issueHistory.newValue, like))))
    .limit(MAX_SCOPE_ISSUES)
  return [...new Set(rows.map((r) => r.id))]
}

const splitList = (v: string | null, sep: string) => (v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : [])

/** Sprint scope: current members plus issues that left the sprint (found through their `Sprint` history). */
export async function loadSprintScope(
  sprint: typeof schema.sprints.$inferSelect, board: Board, unit: ReportUnit, viewerId?: number,
): Promise<ScopedIssue[]> {
  const members = await db.select().from(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, sprint.id))
  const memberAdded = new Map(members.map((m) => [m.issueId, m.addedAt?.getTime() ?? null]))
  const mentioned = await candidatesFromHistory('Sprint', sprint.name)
  const extra = mentioned.filter((id) => !memberAdded.has(id))
  let ids = [...memberAdded.keys()]
  if (extra.length) {
    // Issues removed from the sprint stay in the report for their time inside it, but only from this board's project.
    const own = await db.select({ id: schema.issues.id }).from(schema.issues)
      .where(and(inArray(schema.issues.id, extra), eq(schema.issues.projectId, board.projectId)))
    ids = ids.concat(own.map((r) => r.id))
  }
  const [issues, events] = await Promise.all([loadIssues(ids, unit, viewerId), historyRows('Sprint', ids)])
  const start = sprint.startDate?.getTime() ?? Date.now()
  const dropFrom = sprint.state === 'closed' && sprint.completeDate ? sprint.completeDate.getTime() - 5000 : undefined
  return issues.map((i) => {
    const ev: MembershipEvent[] = (events.get(i.id) ?? []).map((e) => ({
      at: e.at, before: splitList(e.old, ',').includes(sprint.name), after: splitList(e.next, ',').includes(sprint.name),
    })).filter((e) => e.before !== e.after)
    return {
      ...i,
      intervals: intervalsFromEvents(ev, { currentlyMember: memberAdded.has(i.id), fallbackFrom: memberAdded.get(i.id) ?? start, dropFrom }),
    }
  })
}

/** Fix version scope. Issues from projects the viewer cannot browse are left out. */
export async function loadVersionScope(versionId: number, user: User, unit: ReportUnit): Promise<ScopedIssue[]> {
  const current = (await db.select({ id: schema.issueFixVersions.issueId }).from(schema.issueFixVersions)
    .where(eq(schema.issueFixVersions.versionId, versionId)).limit(MAX_SCOPE_ISSUES)).map((r) => r.id)
  const mentioned = await candidatesFromHistory('fixVersions', String(versionId))
  return scopedByField('fixVersions', [...new Set([...current, ...mentioned])], new Set(current), user, unit,
    (v) => splitList(v, ',').includes(String(versionId)))
}

/** Epic scope: direct children (stories, tasks, bugs), including ones that were moved out of the epic. */
export async function loadEpicScope(epicId: number, user: User, unit: ReportUnit): Promise<ScopedIssue[]> {
  const current = (await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.parentId, epicId)).limit(MAX_SCOPE_ISSUES)).map((r) => r.id)
  const mentioned = await candidatesFromHistory('parent', String(epicId))
  return scopedByField('parent', [...new Set([...current, ...mentioned])], new Set(current), user, unit, (v) => v === String(epicId))
}

async function scopedByField(
  field: string, candidates: number[], currentIds: Set<number>, user: User, unit: ReportUnit, matches: (v: string | null) => boolean,
): Promise<ScopedIssue[]> {
  if (candidates.length === 0) return []
  const browsable = await getBrowsableProjectIds(user)
  const allowed = new Set((await db.select({ id: schema.issues.id }).from(schema.issues)
    .where(and(inArray(schema.issues.id, candidates), inArray(schema.issues.projectId, browsable.length ? browsable : [-1])))).map((r) => r.id))
  const ids = candidates.filter((id) => allowed.has(id)).slice(0, MAX_SCOPE_ISSUES)
  const [issues, events] = await Promise.all([loadIssues(ids, unit, user.id), historyRows(field, ids)])
  return issues.map((i) => {
    const ev: MembershipEvent[] = (events.get(i.id) ?? [])
      .map((e) => ({ at: e.at, before: matches(e.old), after: matches(e.next) }))
      .filter((e) => e.before !== e.after)
    return { ...i, intervals: intervalsFromEvents(ev, { currentlyMember: currentIds.has(i.id), fallbackFrom: i.createdAt }) }
  })
}
