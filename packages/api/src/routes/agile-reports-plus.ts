import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { cacheMiddleware } from '../middleware/cache'
import { issueVisibleSql } from '../security/issue-security'
import { boardGuard, categoryOf, loadEpicScope, loadSprintScope, loadVersionScope, unitOf } from '../agile/report-data'
import { burnup, inScopeAt, releaseBurndown, summarizeVersion, type ScopedIssue, type VersionIssueRow } from '../reports/burnup'
import { doneAt } from '../reports/agile'

/** Burnup, release burndown, version and epic reports. Cached for a minute per user (see agile/cache). */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const DAY = 86_400_000
const TTL = 60

const lookbackOf = (c: any) => Math.min(Math.max(Number(c.req.query('lookback')) || 14, 1), 180)
const dateMs = (d: string | null) => (d ? Date.parse(`${d}T00:00:00Z`) : null)
const firstJoin = (issues: ScopedIssue[], now: number) => Math.min(now, ...issues.flatMap((i) => i.intervals.map((iv) => iv.from)))

async function versionOf(c: any, board: { projectId: number }) {
  const id = Number(c.req.query('versionId'))
  if (!Number.isInteger(id)) return null
  const [v] = await db.select().from(schema.versions).where(and(eq(schema.versions.id, id), eq(schema.versions.projectId, board.projectId))).limit(1)
  return v ?? null
}

async function epicOf(c: any, board: { projectId: number }) {
  const key = (c.req.query('epicKey') ?? '').trim().toUpperCase()
  if (!key) return null
  const [e] = await db.select().from(schema.issues).where(and(eq(schema.issues.issueKey, key), eq(schema.issues.projectId, board.projectId), issueVisibleSql(c.get('user').id))).limit(1)
  return e ?? null
}

/** Versions of the board's project (the project settings list needs PROJECT_ADMIN; reports only need BROWSE). */
app.get('/rest/agile/1.0/board/:boardId/report/versions', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const rows = await db.select().from(schema.versions).where(eq(schema.versions.projectId, board.projectId))
  return c.json({
    versions: rows.sort((a, b) => b.id - a.id).map((v) => ({
      id: v.id, name: v.name, startDate: v.startDate, releaseDate: v.releaseDate, released: !!v.released, archived: !!v.archived,
    })),
  })
})

app.get('/rest/agile/1.0/board/:boardId/report/burnup', requireAuth, cacheMiddleware(TTL), async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const unit = unitOf(c)
  const scope = c.req.query('scope') ?? 'sprint'
  const cat = await categoryOf()
  const user = c.get('user')!
  if (scope === 'sprint') {
    const [sprint] = await db.select().from(schema.sprints)
      .where(and(eq(schema.sprints.id, Number(c.req.query('sprintId'))), eq(schema.sprints.boardId, board.id))).limit(1)
    if (!sprint || !sprint.startDate || !sprint.endDate) return c.json({ errorMessages: ['Sprint not found or has no dates'] }, 404)
    const issues = await loadSprintScope(sprint, board, unit, c.get('user')!.id)
    const now = sprint.completeDate?.getTime() ?? Date.now()
    return c.json({
      unit, sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
      ...burnup({ start: sprint.startDate.getTime(), end: sprint.endDate.getTime(), now, issues, cat }),
    })
  }
  if (scope === 'version') {
    const v = await versionOf(c, board); if (!v) return notFound(c)
    const issues = await loadVersionScope(v.id, user, unit)
    const now = Date.now()
    const release = dateMs(v.releaseDate)
    const start = Math.min(dateMs(v.startDate) ?? firstJoin(issues, now), now)
    // A released version stops at its release date; an open one runs to the planned date (or today).
    const end = v.released ? (release ?? now) : Math.max(release ?? now, now)
    const at = v.released ? Math.min(now, end + DAY - 1) : now
    return c.json({ unit, version: { id: v.id, name: v.name }, ...burnup({ start, end, now: at, issues, cat }) })
  }
  if (scope === 'epic') {
    const e = await epicOf(c, board); if (!e) return notFound(c)
    const issues = await loadEpicScope(e.id, user, unit)
    const now = Date.now()
    return c.json({ unit, epic: { key: e.issueKey, summary: e.summary }, ...burnup({ start: Math.min(e.createdAt!.getTime(), now), end: now, now, issues, cat }) })
  }
  return c.json({ errorMessages: ['scope must be sprint, version or epic'] }, 400)
})

app.get('/rest/agile/1.0/board/:boardId/report/release-burndown', requireAuth, cacheMiddleware(TTL), async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const v = await versionOf(c, board); if (!v) return notFound(c)
  const unit = unitOf(c)
  const issues = await loadVersionScope(v.id, c.get('user')!, unit)
  const now = Date.now()
  const r = releaseBurndown({
    start: Math.min(dateMs(v.startDate) ?? firstJoin(issues, now), now), releaseDate: dateMs(v.releaseDate), now, issues,
    cat: await categoryOf(), lookbackDays: lookbackOf(c),
  })
  return c.json({ unit, version: { id: v.id, name: v.name, released: !!v.released, releaseDate: v.releaseDate }, ...r })
})

app.get('/rest/agile/1.0/board/:boardId/report/epic-burndown', requireAuth, cacheMiddleware(TTL), async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const e = await epicOf(c, board); if (!e) return notFound(c)
  const unit = unitOf(c)
  const now = Date.now()
  const r = releaseBurndown({
    start: Math.min(e.createdAt!.getTime(), now), releaseDate: e.dueDate ? e.dueDate.getTime() : null, now,
    issues: await loadEpicScope(e.id, c.get('user')!, unit), cat: await categoryOf(), lookbackDays: lookbackOf(c),
  })
  return c.json({ unit, epic: { key: e.issueKey, summary: e.summary }, ...r })
})

/** Jira's "Version report": counts, completed vs remaining, projected release date, issues grouped by status. */
app.get('/rest/agile/1.0/board/:boardId/report/version', requireAuth, cacheMiddleware(TTL), async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const v = await versionOf(c, board); if (!v) return notFound(c)
  const unit = unitOf(c)
  const cat = await categoryOf()
  const scoped = await loadVersionScope(v.id, c.get('user')!, unit)
  const now = Date.now()
  const members = scoped.filter((i) => inScopeAt(i, now))
  const ids = members.map((i) => i.id)
  const rows = ids.length ? await db.select({
    id: schema.issues.id, status: schema.statuses.name, type: schema.issueTypes.name,
    assignee: schema.users.displayName, priority: schema.priorities.name,
  }).from(schema.issues)
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .leftJoin(schema.users, eq(schema.users.id, schema.issues.assigneeId))
    .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
    .where(inArray(schema.issues.id, ids)) : []
  const info = new Map(rows.map((r) => [r.id, r]))
  const table: VersionIssueRow[] = members.map((i) => {
    const r = info.get(i.id)
    const status = r?.status ?? 'To Do'
    return {
      key: i.key, summary: i.summary, status, category: cat(status), type: r?.type ?? null, assignee: r?.assignee ?? null,
      priority: r?.priority ?? null, size: i.size, estimated: i.estimated !== false, flagged: i.flagged === true,
    }
  })
  const burn = releaseBurndown({
    start: Math.min(dateMs(v.startDate) ?? firstJoin(scoped, now), now), releaseDate: dateMs(v.releaseDate), now, issues: scoped, cat, lookbackDays: lookbackOf(c),
  })
  return c.json({
    unit,
    version: { id: v.id, name: v.name, description: v.description, startDate: v.startDate, releaseDate: v.releaseDate, released: !!v.released, archived: !!v.archived },
    ...summarizeVersion(table),
    projection: v.released ? null : {
      velocityPerDay: burn.velocityPerDay, lookbackDays: burn.lookbackDays, projectedDate: burn.projectedDate,
      releaseDate: burn.releaseDate, onTrack: burn.onTrack, daysLate: burn.daysLate,
    },
  })
})

export default app
