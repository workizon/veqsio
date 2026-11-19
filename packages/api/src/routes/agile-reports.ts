import { Hono } from 'hono'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { issueVisibleSql } from '../security/issue-security'
import {
  burndown, controlChart, countUnestimated, cumulativeFlow, doneAt, epicProgress, sizeFor, sprintSummary,
  type ReportUnit,
  type Category,
} from '../reports/agile'

import roadmapRoutes from './roadmap'
import plusRoutes from './agile-reports-plus'
import { boardGuard, categoryOf, loadIssues, loadSprintScope, sprintIssueIds, unitOf } from '../agile/report-data'
import { scopeChanges } from '../reports/burnup'
import { reportCategory } from '../workflow/status-groups'

const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const DAY = 86_400_000

app.get('/rest/agile/1.0/board/:boardId/report/burndown', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const sprintId = Number(c.req.query('sprintId'))
  const [sprint] = await db.select().from(schema.sprints).where(and(eq(schema.sprints.id, sprintId), eq(schema.sprints.boardId, board.id))).limit(1)
  if (!sprint || !sprint.startDate || !sprint.endDate) return c.json({ errorMessages: ['Sprint not found or has no dates'] }, 404)
  const [issues, cat] = await Promise.all([loadIssues(await sprintIssueIds(sprint.id, c.get('user')!.id), unitOf(c), c.get('user')!.id), categoryOf()])
  const now = sprint.completeDate?.getTime() ?? Date.now()
  return c.json({ sprint: { id: sprint.id, name: sprint.name, state: sprint.state }, unit: unitOf(c), ...burndown({ start: sprint.startDate.getTime(), end: sprint.endDate.getTime(), now, issues, cat }) })
})

app.get('/rest/agile/1.0/board/:boardId/report/sprint', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const sprintId = Number(c.req.query('sprintId'))
  const [sprint] = await db.select().from(schema.sprints).where(and(eq(schema.sprints.id, sprintId), eq(schema.sprints.boardId, board.id))).limit(1)
  if (!sprint) return notFound(c)
  const [issues, cat] = await Promise.all([loadIssues(await sprintIssueIds(sprint.id, c.get('user')!.id), unitOf(c), c.get('user')!.id), categoryOf()])
  const asOf = sprint.completeDate?.getTime() ?? sprint.endDate?.getTime() ?? Date.now()
  // Work added to or removed from the sprint after it started (from sprint_issues.added_at and Sprint history).
  const changes = sprint.startDate ? scopeChanges(await loadSprintScope(sprint, board, unitOf(c), c.get('user')!.id), sprint.startDate.getTime(), asOf) : []
  return c.json({ sprint: { id: sprint.id, name: sprint.name, state: sprint.state, goal: sprint.goal }, unit: unitOf(c), ...sprintSummary(issues, cat, asOf), scopeChanges: changes })
})

app.get('/rest/agile/1.0/board/:boardId/report/velocity', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const closed = await db.select().from(schema.sprints)
    .where(and(eq(schema.sprints.boardId, board.id), eq(schema.sprints.state, 'closed'))).orderBy(asc(schema.sprints.endDate))
  const last = closed.slice(-Math.min(Math.max(Number(c.req.query('count')) || 8, 1), 30))
  const cat = await categoryOf()
  const out = []
  for (const s of last) {
    const issues = await loadIssues(await sprintIssueIds(s.id, c.get('user')!.id), unitOf(c), c.get('user')!.id)
    const sum = sprintSummary(issues, cat, s.completeDate?.getTime() ?? s.endDate?.getTime() ?? Date.now())
    out.push({ sprintId: s.id, name: s.name, committed: sum.committed, completed: sum.completed, unestimated: sum.unestimated })
  }
  const avg = out.length ? out.reduce((a, s) => a + s.completed, 0) / out.length : null
  return c.json({ unit: unitOf(c), sprints: out, averageVelocity: avg, unestimated: out.reduce((a, s) => a + s.unestimated, 0) })
})

/** Issues on the board's project, used for flow reports. */
async function projectIssueIds(projectId: number, viewerId: number, limit = 5000) {
  return (await db.select({ id: schema.issues.id }).from(schema.issues).where(and(eq(schema.issues.projectId, projectId), issueVisibleSql(viewerId))).limit(limit)).map((r) => r.id)
}

/** Whether the board's project has any story-pointed issue (drives the reports page default unit). */
app.get('/rest/agile/1.0/board/:boardId/report/units', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const [row] = await db.select({ id: schema.issues.id }).from(schema.issues)
    .where(and(eq(schema.issues.projectId, board.projectId), isNotNull(schema.issues.storyPoints), issueVisibleSql(c.get('user')!.id))).limit(1)
  return c.json({ hasPoints: !!row, defaultUnit: row ? 'points' : 'issues' })
})

app.get('/rest/agile/1.0/board/:boardId/report/cfd', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 7), 365)
  const [issues, cat] = await Promise.all([loadIssues(await projectIssueIds(board.projectId, c.get('user')!.id), 'issues', c.get('user')!.id), categoryOf()])
  const to = Date.now()
  return c.json({ points: cumulativeFlow({ from: to - days * DAY, to, issues, cat }) })
})

app.get('/rest/agile/1.0/board/:boardId/report/control', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 7), 365)
  const [issues, cat] = await Promise.all([loadIssues(await projectIssueIds(board.projectId, c.get('user')!.id), 'issues', c.get('user')!.id), categoryOf()])
  const to = Date.now()
  return c.json(controlChart({ issues, cat, from: to - days * DAY, to }))
})

app.get('/rest/agile/1.0/board/:boardId/report/epics', requireAuth, async (c) => {
  const board = await boardGuard(c); if (!board) return notFound(c)
  const rows = await db.select({ issue: schema.issues, type: schema.issueTypes.name, status: schema.statuses.category })
    .from(schema.issues)
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(and(eq(schema.issues.projectId, board.projectId), issueVisibleSql(c.get('user')!.id))).limit(10_000)
  const epics = rows.filter((r) => r.type.toLowerCase() === 'epic')
  const byId = new Map(epics.map((e) => [e.issue.id, e.issue.issueKey]))
  const children = rows.filter((r) => r.issue.parentId && byId.has(r.issue.parentId)).map((r) => ({
    epicKey: byId.get(r.issue.parentId!)!,
    category: reportCategory(r.status) as Category,
    ...sizeFor(unitOf(c), r.issue),
  }))
  return c.json({
    unit: unitOf(c),
    unestimated: countUnestimated(children),
    epics: epicProgress(epics.map((e) => ({ key: e.issue.issueKey, summary: e.issue.summary })), children),
  })
})

app.route('/', roadmapRoutes)
app.route('/', plusRoutes)

export default app
