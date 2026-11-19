import { parseSprintAutomation, nextSprintName, nextSprintDates } from '../agile/automation'
import { reportCategory } from '../workflow/status-groups'
import { Hono } from 'hono'
import { z } from 'zod'
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { invalidateAgileCaches } from '../agile/cache'
import {
  insertRank, normalizeIssueKeys, parallelSprintsAllowed, parseMoveTarget,
  planMove, splitForCompletion, sumPoints, toPoints, validateSprintStart, type StatusCategory,
} from '../agile/planning'
import { pointsByIssue, storyPointFieldIds } from '../agile/points'
import { issueVisibleSql } from '../security/issue-security'
import { notifySprintEvent } from '../services/notifications'
import { publish } from '../realtime/hub'
import { publishSprint } from '../realtime/publish'

/**
 * Sprint planning: moving issues between sprints and the backlog, starting and completing sprints,
 * and the combined planning/backlog reads the backlog page uses. Jira-compatible paths under
 * /rest/agile/1.0. Writes need MANAGE_SPRINTS on the sprint's (or issue's) project, reads
 * BROWSE_PROJECTS. Unknown ids answer 404, missing permission 403.
 */
const app = new Hono<AppContext>()

const err = (c: any, status: number, ...messages: string[]) => c.json({ errorMessages: messages }, status)
const OPEN = ['future', 'active']

type Sprint = typeof schema.sprints.$inferSelect
type Board = typeof schema.boards.$inferSelect

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date')

async function readBody<T extends z.ZodTypeAny>(c: any, parser: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown
  try { raw = await c.req.json() } catch { raw = {} }
  const parsed = parser.safeParse(raw ?? {})
  if (!parsed.success) {
    return { ok: false, res: err(c, 400, ...parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)) }
  }
  return { ok: true, data: parsed.data }
}

/** Loads the sprint and its board and checks the permission; returns a Response when denied. */
async function sprintGuard(c: any, permission: 'MANAGE_SPRINTS' | 'BROWSE_PROJECTS'): Promise<{ sprint: Sprint; board: Board } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) return err(c, 404, 'Sprint not found')
  const [row] = await db.select({ sprint: schema.sprints, board: schema.boards })
    .from(schema.sprints).innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId))
    .where(eq(schema.sprints.id, id)).limit(1)
  if (!row) return err(c, 404, 'Sprint not found')
  if (!(await checkProjectPermission(c.get('user'), row.board.projectId, permission))) {
    return permission === 'BROWSE_PROJECTS' ? err(c, 404, 'Sprint not found') : err(c, 403, 'Forbidden')
  }
  return row
}

async function boardGuard(c: any): Promise<{ board: Board } | Response> {
  const id = Number(c.req.param('boardId'))
  if (!Number.isInteger(id) || id < 1) return err(c, 404, 'Board not found')
  const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1)
  if (!board) return err(c, 404, 'Board not found')
  if (!(await checkProjectPermission(c.get('user'), board.projectId, 'BROWSE_PROJECTS'))) return err(c, 404, 'Board not found')
  return { board }
}

const isResponse = (v: unknown): v is Response => v instanceof Response

export const serializeSprint = (s: Sprint) => ({
  id: s.id,
  name: s.name,
  goal: s.goal,
  state: s.state,
  startDate: s.startDate?.toISOString(),
  endDate: s.endDate?.toISOString(),
  completeDate: s.completeDate?.toISOString(),
  originBoardId: s.boardId,
})

/* ------------------------------------------------------------------ */
/*  Data helpers                                                      */
/* ------------------------------------------------------------------ */

export interface PlanningRow {
  id: string
  key: string
  fields: {
    summary: string
    status: { name: string; statusCategory: { key: StatusCategory } }
    priority: { name: string } | null
    issuetype: { name: string; subtask: boolean }
    assignee: { accountId: string; displayName: string } | null
    storyPoints: number | null
    flagged: boolean
    parentKey?: string | null
  }
}

/** Planning rows for the given issue ids, in that order. One query plus one for story points. */
/** `viewerId`: the user the rows are for (issue security levels apply; null = anonymous). */
async function loadRows(issueIds: number[], viewerId: number | null): Promise<PlanningRow[]> {
  if (issueIds.length === 0) return []
  const [rows, points] = await Promise.all([
    db.select({
      id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary,
      typeName: schema.issueTypes.name, isSubtask: schema.issueTypes.isSubtask,
      statusName: schema.statuses.name, category: schema.statuses.category,
      priorityName: schema.priorities.name, flagged: schema.issues.flagged,
      assigneeId: schema.users.id, assigneeName: schema.users.displayName,
    })
      .from(schema.issues)
      .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
      .leftJoin(schema.users, eq(schema.users.id, schema.issues.assigneeId))
      .where(and(inArray(schema.issues.id, issueIds), issueVisibleSql(viewerId))),
    pointsByIssue(issueIds),
  ])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: PlanningRow[] = []
  for (const id of issueIds) {
    const r = byId.get(id)
    if (!r) continue
    out.push({
      id: String(r.id),
      key: r.key,
      fields: {
        summary: r.summary,
        status: { name: r.statusName, statusCategory: { key: categoryOf(r.category) } },
        priority: r.priorityName ? { name: r.priorityName } : null,
        issuetype: { name: r.typeName, subtask: !!r.isSubtask },
        assignee: r.assigneeId ? { accountId: String(r.assigneeId), displayName: r.assigneeName ?? '' } : null,
        storyPoints: points.get(r.id) ?? null,
        flagged: r.flagged === true,
      },
    })
  }
  return out
}

const categoryOf = (c: string | null | undefined): StatusCategory => reportCategory(c)

/** Members of a sprint in planning order. */
async function sprintMemberIds(sprintId: number, limit?: number, offset = 0, viewerId?: number | null): Promise<number[]> {
  const q = db.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sprintIssues.issueId))
    .where(and(eq(schema.sprintIssues.sprintId, sprintId), viewerId === undefined ? undefined : issueVisibleSql(viewerId)))
    .orderBy(asc(schema.sprintIssues.sortOrder), asc(schema.sprintIssues.issueId))
  const rows = limit ? await q.limit(limit).offset(offset) : await q
  return rows.map((r) => r.id)
}

/** Reorders sprint members to `order` (sort_order 0..n); only writes rows whose position changed. */
async function writeOrder(tx: any, sprintId: number, order: number[]) {
  const current = await tx.select({ id: schema.sprintIssues.issueId, o: schema.sprintIssues.sortOrder }).from(schema.sprintIssues)
    .where(eq(schema.sprintIssues.sprintId, sprintId))
  const cur = new Map<number, number>(current.map((r: any) => [r.id, r.o]))
  for (let i = 0; i < order.length; i++) {
    if (cur.get(order[i]) !== i) {
      await tx.update(schema.sprintIssues).set({ sortOrder: i })
        .where(and(eq(schema.sprintIssues.sprintId, sprintId), eq(schema.sprintIssues.issueId, order[i])))
    }
  }
}

async function resolveIssues(keys: string[], viewerId: number) {
  // An issue hidden by its security level is reported as "not found", like a missing one.
  const rows = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, projectId: schema.issues.projectId })
    .from(schema.issues).where(and(inArray(schema.issues.issueKey, keys), issueVisibleSql(viewerId)))
  const found = new Map(rows.map((r) => [r.key.toUpperCase(), r]))
  // Keys are matched case-insensitively; stored keys are upper case in practice.
  const missing = keys.filter((k) => !found.has(k))
  return { rows: keys.map((k) => found.get(k)).filter(Boolean) as typeof rows, missing }
}

async function openSprintMemberships(issueIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>()
  if (issueIds.length === 0) return out
  const rows = await db.select({ issueId: schema.sprintIssues.issueId, sprintId: schema.sprintIssues.sprintId })
    .from(schema.sprintIssues).innerJoin(schema.sprints, eq(schema.sprints.id, schema.sprintIssues.sprintId))
    .where(and(inArray(schema.sprintIssues.issueId, issueIds), inArray(schema.sprints.state, OPEN)))
  for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.sprintId])
  return out
}

async function sprintNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: schema.sprints.id, name: schema.sprints.name }).from(schema.sprints).where(inArray(schema.sprints.id, ids))
  return new Map(rows.map((r) => [r.id, r.name]))
}

const issueKeysBody = z.object({
  issues: z.array(z.string().min(1).max(100)).min(1, 'issues must contain at least one issue key').max(200, 'at most 200 issues per request'),
  rankBeforeIssue: z.string().min(1).max(100).optional(),
  rankAfterIssue: z.string().min(1).max(100).optional(),
})

/* ------------------------------------------------------------------ */
/*  Move issues into a sprint / back to the backlog                   */
/* ------------------------------------------------------------------ */

app.post('/rest/agile/1.0/sprint/:id/issue', requireAuth, async (c) => {
  const guard = await sprintGuard(c, 'MANAGE_SPRINTS'); if (isResponse(guard)) return guard
  const { sprint, board } = guard
  const body = await readBody(c, issueKeysBody); if (!body.ok) return body.res
  if (sprint.state === 'closed') return err(c, 400, 'Issues cannot be added to a closed sprint')

  const keys = normalizeIssueKeys(body.data.issues)
  const { rows, missing } = await resolveIssues(keys, c.get('user')!.id)
  if (missing.length) return err(c, 400, `Issues not found: ${missing.join(', ')}`)
  const foreign = rows.filter((r) => r.projectId !== board.projectId)
  if (foreign.length) return err(c, 400, `Issues belong to a different project than the sprint's board: ${foreign.map((r) => r.key).join(', ')}`)

  const issueIds = rows.map((r) => r.id)
  const memberships = await openSprintMemberships(issueIds)
  const plan = planMove(issueIds.map((issueId) => ({ issueId, openSprintIds: memberships.get(issueId) ?? [] })), sprint.id)
  const names = await sprintNames([...new Set(plan.remove.map((r) => r.sprintId)), sprint.id])
  const user = c.get('user')!

  const anchorKey = (k?: string) => (k ? rows.find((r) => r.key === k.trim().toUpperCase())?.id : undefined)
  const before = body.data.rankBeforeIssue?.trim().toUpperCase()
  const after = body.data.rankAfterIssue?.trim().toUpperCase()

  await db.transaction(async (tx) => {
    for (const r of plan.remove) {
      await tx.delete(schema.sprintIssues).where(and(eq(schema.sprintIssues.sprintId, r.sprintId), eq(schema.sprintIssues.issueId, r.issueId)))
    }
    const order = (await tx.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues)
      .where(eq(schema.sprintIssues.sprintId, sprint.id))
      .orderBy(asc(schema.sprintIssues.sortOrder), asc(schema.sprintIssues.issueId))).map((r) => r.id)
    if (plan.add.length) {
      await tx.insert(schema.sprintIssues).values(plan.add.map((issueId, i) => ({ sprintId: sprint.id, issueId, sortOrder: order.length + i })))
        .onConflictDoNothing()
    }
    const anchor = async (k?: string) => {
      if (!k) return null
      const [r] = await tx.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, k)).limit(1)
      return r?.id ?? null
    }
    const beforeId = anchorKey(before) ?? (await anchor(before))
    const afterId = anchorKey(after) ?? (await anchor(after))
    const next = insertRank([...order, ...plan.add], issueIds, beforeId, afterId)
    await writeOrder(tx, sprint.id, next)

    const history: Array<typeof schema.issueHistory.$inferInsert> = []
    for (const issueId of plan.add) {
      const from = (memberships.get(issueId) ?? []).map((s) => names.get(s) ?? String(s)).join(', ') || null
      history.push({ issueId, fieldName: 'Sprint', oldValue: from, newValue: sprint.name, authorId: user.id })
    }
    if (history.length) await tx.insert(schema.issueHistory).values(history)
  })

  await invalidateAgileCaches(keys)
  publishSprint(sprint.id, c.get('user')?.id)
  return c.json({
    sprintId: sprint.id, moved: plan.add.length, unchanged: plan.unchanged.length, issues: keys,
    // True when the sprint is already running, i.e. this changes its committed scope.
    scopeChange: sprint.state === 'active' && plan.add.length > 0,
  })
})

app.post('/rest/agile/1.0/backlog/issue', requireAuth, async (c) => {
  const body = await readBody(c, issueKeysBody); if (!body.ok) return body.res
  const keys = normalizeIssueKeys(body.data.issues)
  const { rows, missing } = await resolveIssues(keys, c.get('user')!.id)
  if (missing.length) return err(c, 400, `Issues not found: ${missing.join(', ')}`)

  const user = c.get('user')!
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    if (!(await checkProjectPermission(user, projectId, 'MANAGE_SPRINTS'))) return err(c, 403, 'Forbidden')
  }

  const issueIds = rows.map((r) => r.id)
  const memberships = await openSprintMemberships(issueIds)
  const plan = planMove(issueIds.map((issueId) => ({ issueId, openSprintIds: memberships.get(issueId) ?? [] })), null)
  const names = await sprintNames([...new Set(plan.remove.map((r) => r.sprintId))])

  await db.transaction(async (tx) => {
    for (const r of plan.remove) {
      await tx.delete(schema.sprintIssues).where(and(eq(schema.sprintIssues.sprintId, r.sprintId), eq(schema.sprintIssues.issueId, r.issueId)))
    }
    const history = [...new Set(plan.remove.map((r) => r.issueId))].map((issueId) => ({
      issueId, fieldName: 'Sprint',
      oldValue: (memberships.get(issueId) ?? []).map((s) => names.get(s) ?? String(s)).join(', ') || null,
      newValue: null, authorId: user.id,
    }))
    if (history.length) await tx.insert(schema.issueHistory).values(history)
  })

  // Optional ranking inside the backlog (drag to reorder). Needs a single project: ranks are per backlog.
  const rankBefore = body.data.rankBeforeIssue?.trim().toUpperCase()
  const rankAfter = body.data.rankAfterIssue?.trim().toUpperCase()
  if (rankBefore || rankAfter) {
    const projectIds = [...new Set(rows.map((r) => r.projectId))]
    if (projectIds.length !== 1) return err(c, 400, 'Ranking needs issues from a single project')
    const [anchor] = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues)
      .where(eq(schema.issues.issueKey, (rankBefore || rankAfter)!)).limit(1)
    if (!anchor || anchor.projectId !== projectIds[0]) return err(c, 400, 'Rank anchor issue is not in the same project')
    const order = await rankBacklog(projectIds[0], issueIds, rankBefore ? anchor.id : null, rankBefore ? null : anchor.id)
    if (!order) return err(c, 400, 'Rank anchor issue is not in the backlog')
  }

  await invalidateAgileCaches(keys)
  for (const projectId of new Set(rows.map((r) => r.projectId))) publish('sprint.updated', { key: 'backlog', projectId, actorId: user.id })
  return c.json({ moved: new Set(plan.remove.map((r) => r.issueId)).size, unchanged: plan.unchanged.length, issues: keys })
})

/* ------------------------------------------------------------------ */
/*  Start / complete                                                  */
/* ------------------------------------------------------------------ */

const startBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  goal: z.string().max(2000).nullable().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
})

app.post('/rest/agile/1.0/sprint/:id/start', requireAuth, async (c) => {
  const guard = await sprintGuard(c, 'MANAGE_SPRINTS'); if (isResponse(guard)) return guard
  const { sprint, board } = guard
  const body = await readBody(c, startBody); if (!body.ok) return body.res
  const d = body.data

  const merged = {
    state: sprint.state,
    name: d.name ?? sprint.name,
    startDate: d.startDate ? new Date(d.startDate) : sprint.startDate,
    endDate: d.endDate ? new Date(d.endDate) : sprint.endDate,
  }
  const errors = validateSprintStart(merged)
  if (errors.length) return err(c, 400, ...errors)

  const others = await db.select({ id: schema.sprints.id, name: schema.sprints.name }).from(schema.sprints)
    .where(and(eq(schema.sprints.boardId, board.id), eq(schema.sprints.state, 'active')))
  if (others.length && !parallelSprintsAllowed(board.config)) {
    return err(c, 409, `Board already has an active sprint (${others.map((o) => o.name).join(', ')}) and parallel sprints are disabled for it`)
  }

  const [updated] = await db.update(schema.sprints)
    .set({
      state: 'active', name: merged.name, startDate: merged.startDate, endDate: merged.endDate,
      ...(d.goal !== undefined ? { goal: d.goal } : {}),
    })
    .where(and(eq(schema.sprints.id, sprint.id), eq(schema.sprints.state, 'future'))).returning()
  if (!updated) return err(c, 409, 'Sprint was already started')

  const ids = await sprintMemberIds(sprint.id)
  const points = await pointsByIssue(ids)
  await invalidateAgileCaches()
  void notifySprintEvent(updated, 'started').catch(() => {})
  publishSprint(sprint.id, c.get('user')?.id)
  return c.json({
    ...serializeSprint(updated),
    issueCount: ids.length,
    storyPoints: sumPoints(ids.map((id) => ({ points: points.get(id) }))),
    parallelActiveSprints: others.length > 0,
    warnings: others.map((o) => `Another sprint is already active on this board: ${o.name}`),
  })
})

const completeBody = z.object({
  moveIncompleteTo: z.union([z.literal('backlog'), z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
})

app.post('/rest/agile/1.0/sprint/:id/complete', requireAuth, async (c) => {
  const guard = await sprintGuard(c, 'MANAGE_SPRINTS'); if (isResponse(guard)) return guard
  const { sprint, board } = guard
  const body = await readBody(c, completeBody); if (!body.ok) return body.res
  if (sprint.state !== 'active') return err(c, 400, 'Only active sprints can be completed')

  const explicitTarget = body.data.moveIncompleteTo !== undefined
  const target = parseMoveTarget(body.data.moveIncompleteTo ?? 'backlog')
  if (target === null) return err(c, 400, 'moveIncompleteTo must be "backlog" or a sprint id')
  let targetSprint: Sprint | null = null
  if (target !== 'backlog') {
    if (target === sprint.id) return err(c, 400, 'Incomplete issues cannot be moved into the sprint being completed')
    const [t] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, target)).limit(1)
    if (!t || t.boardId !== board.id) return err(c, 400, 'Target sprint was not found on this board')
    if (t.state === 'closed') return err(c, 400, 'Incomplete issues cannot be moved into a closed sprint')
    targetSprint = t
  }

  const ids = await sprintMemberIds(sprint.id)
  const [rows, points] = await Promise.all([
    ids.length
      ? db.select({ id: schema.issues.id, key: schema.issues.issueKey, category: schema.statuses.category })
          .from(schema.issues).innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
          .where(inArray(schema.issues.id, ids))
      : Promise.resolve([] as Array<{ id: number; key: string; category: string | null }>),
    pointsByIssue(ids),
  ])
  const keyOf = new Map(rows.map((r) => [r.id, r.key]))
  const cat = new Map(rows.map((r) => [r.id, categoryOf(r.category)]))
  const split = splitForCompletion(ids.map((id) => ({ id, category: cat.get(id) ?? 'todo', points: points.get(id) })))
  const incompleteIds = split.incomplete.map((i) => i.id)
  const user = c.get('user')!
  const completeDate = new Date()
  const auto = parseSprintAutomation(board.config)
  let createdSprint: Sprint | null = null

  const closed = await db.transaction(async (tx) => {
    const [u] = await tx.update(schema.sprints).set({ state: 'closed', completeDate })
      .where(and(eq(schema.sprints.id, sprint.id), eq(schema.sprints.state, 'active'))).returning()
    if (!u) return null
    // Sprint automation: make sure a next sprint exists (reuse the earliest future one) and, unless the caller chose
    // a target, carry unfinished work over to it.
    if (auto.autoCreateNext) {
      const [future] = await tx.select().from(schema.sprints)
        .where(and(eq(schema.sprints.boardId, board.id), eq(schema.sprints.state, 'future'))).orderBy(asc(schema.sprints.id)).limit(1)
      let next: Sprint | undefined = future
      if (!next) {
        const dates = nextSprintDates(completeDate, auto.durationDays)
        ;[next] = await tx.insert(schema.sprints).values({ name: nextSprintName(sprint.name), state: 'future', boardId: board.id, ...dates }).returning()
        createdSprint = next
      }
      if (!explicitTarget && auto.autoMoveIncomplete === 'next' && next) targetSprint = next
    }
    // Incomplete issues stay linked to the closed sprint (reports show them as not completed);
    // the open sprint membership is what puts them in the next sprint, no membership means backlog.
    if (targetSprint && incompleteIds.length) {
      const existing = new Set((await tx.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues)
        .where(and(eq(schema.sprintIssues.sprintId, targetSprint.id), inArray(schema.sprintIssues.issueId, incompleteIds)))).map((r) => r.id))
      const order = await tx.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, targetSprint.id))
      const add = incompleteIds.filter((id) => !existing.has(id))
      if (add.length) {
        await tx.insert(schema.sprintIssues).values(add.map((issueId, i) => ({ sprintId: targetSprint!.id, issueId, sortOrder: order.length + i }))).onConflictDoNothing()
        await tx.insert(schema.issueHistory).values(add.map((issueId) => ({
          issueId, fieldName: 'Sprint', oldValue: sprint.name, newValue: targetSprint!.name, authorId: user.id,
        })))
      }
    } else if (incompleteIds.length) {
      await tx.insert(schema.issueHistory).values(incompleteIds.map((issueId) => ({
        issueId, fieldName: 'Sprint', oldValue: sprint.name, newValue: null, authorId: user.id,
      })))
    }
    return u
  })
  if (!closed) return err(c, 409, 'Sprint was already completed')

  await invalidateAgileCaches(rows.map((r) => r.key))
  void notifySprintEvent(closed, 'closed').catch(() => {})
  publishSprint(sprint.id, c.get('user')?.id)
  return c.json({
    sprint: serializeSprint(closed),
    summary: {
      completed: split.completed.length,
      cancelled: split.cancelled.length,
      moved: split.incomplete.length,
      completedPoints: split.completedPoints,
      movedPoints: split.incompletePoints,
      movedTo: targetSprint ? { type: 'sprint', id: targetSprint.id, name: targetSprint.name } : { type: 'backlog' },
      createdSprint: createdSprint ? { id: (createdSprint as Sprint).id, name: (createdSprint as Sprint).name } : null,
      completedIssues: split.completed.map((i) => keyOf.get(i.id)),
      movedIssues: split.incomplete.map((i) => keyOf.get(i.id)),
    },
  })
})

const automationBody = z.object({
  autoCreateNext: z.boolean(),
  durationDays: z.number().int().min(1).max(90),
  autoMoveIncomplete: z.enum(['next', 'backlog']),
}).strict()

app.put('/rest/agile/1.0/board/:boardId/sprint-automation', requireAuth, async (c) => {
  const boardId = Number(c.req.param('boardId'))
  const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, boardId)).limit(1)
  const user = c.get('user')!
  if (!board || !(await checkProjectPermission(user, board.projectId, 'BROWSE_PROJECTS'))) return err(c, 404, 'Board not found')
  if (!(await checkProjectPermission(user, board.projectId, 'MANAGE_SPRINTS'))) return err(c, 403, 'Forbidden')
  const body = await readBody(c, automationBody); if (!body.ok) return body.res
  const config = { ...((board.config as Record<string, unknown>) ?? {}), sprintAutomation: body.data }
  await db.update(schema.boards).set({ config }).where(eq(schema.boards.id, board.id))
  return c.json({ sprintAutomation: parseSprintAutomation(config) })
})

/* ------------------------------------------------------------------ */
/*  Reads: sprint issues, backlog, planning view                      */
/* ------------------------------------------------------------------ */

app.get('/rest/agile/1.0/sprint/:id/issue', requireAuth, async (c) => {
  const guard = await sprintGuard(c, 'BROWSE_PROJECTS'); if (isResponse(guard)) return guard
  const startAt = Math.max(Number(c.req.query('startAt')) || 0, 0)
  const maxResults = Math.min(Math.max(Number(c.req.query('maxResults')) || 50, 1), 500)
  const viewer = c.get('user')!.id
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sprintIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sprintIssues.issueId))
    .where(and(eq(schema.sprintIssues.sprintId, guard.sprint.id), issueVisibleSql(viewer)))
  const ids = await sprintMemberIds(guard.sprint.id, maxResults, startAt, viewer)
  return c.json({ startAt, maxResults, total: n, issues: await loadRows(ids, viewer) })
})

function backlogWhere(projectId: number, q: string | undefined, includeDone: boolean, viewerId?: number | null) {
  const si = schema.sprintIssues
  const sp = schema.sprints
  const conds = [
    eq(schema.issues.projectId, projectId),
    sql`NOT EXISTS (SELECT 1 FROM ${si} INNER JOIN ${sp} ON ${sp.id} = ${si.sprintId} WHERE ${si.issueId} = ${schema.issues.id} AND ${sp.state} IN ('future', 'active'))`,
  ]
  if (viewerId !== undefined) conds.push(issueVisibleSql(viewerId))
  if (!includeDone) conds.push(sql`${schema.statuses.category} NOT IN ('done', 'cancelled')`)
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conds.push(or(ilike(schema.issues.summary, like), ilike(schema.issues.issueKey, like))!)
  }
  return and(...conds)
}

const BACKLOG_ORDER = [
  sql`${schema.issues.backlogRank} ASC NULLS LAST`,
  sql`${schema.priorities.sortOrder} ASC NULLS LAST`,
  desc(schema.issues.createdAt),
  desc(schema.issues.id),
]

/** Writes an explicit rank for every backlog issue of a project after placing `moving` before/after an anchor. */
async function rankBacklog(projectId: number, moving: number[], beforeId: number | null, afterId: number | null): Promise<number[] | null> {
  return db.transaction(async (tx) => {
    const ids = (await tx.select({ id: schema.issues.id }).from(schema.issues)
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
      .where(backlogWhere(projectId, undefined, true))
      .orderBy(...BACKLOG_ORDER)).map((r) => r.id)
    const anchor = beforeId ?? afterId
    if (anchor == null || !ids.includes(anchor)) return null
    const next = insertRank(ids, moving.filter((m) => ids.includes(m) && m !== anchor), beforeId, afterId)
    if (next.length === 0) return next
    const values = sql.join(next.map((id, i) => sql`(${id}::int, ${i}::int)`), sql`, `)
    await tx.execute(sql`UPDATE issues SET backlog_rank = v.r FROM (VALUES ${values}) AS v(id, r) WHERE issues.id = v.id AND issues.backlog_rank IS DISTINCT FROM v.r`)
    return next
  })
}

/** One page of backlog issues (ranked by explicit rank, then priority, then newest first) plus the total and points. */
async function loadBacklog(projectId: number, opts: { startAt: number; maxResults: number; q?: string; includeDone: boolean }, viewerId: number) {
  const where = backlogWhere(projectId, opts.q, opts.includeDone, viewerId)
  const base = () => db.select({ id: schema.issues.id }).from(schema.issues)
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
  const [page, [{ n }], fieldIds] = await Promise.all([
    base().where(where)
      .orderBy(...BACKLOG_ORDER)
      .limit(opts.maxResults).offset(opts.startAt),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.issues)
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId)).where(where),
    storyPointFieldIds(),
  ])
  let totalPoints = 0
  if (fieldIds.length) {
    const [t] = await db.select({ s: sql<string>`COALESCE(SUM(${schema.customFieldValues.numberValue}), 0)` }).from(schema.issues)
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .innerJoin(schema.customFieldValues, and(eq(schema.customFieldValues.issueId, schema.issues.id), inArray(schema.customFieldValues.customFieldId, fieldIds)))
      .where(where)
    totalPoints = toPoints(t?.s) ?? 0
  }
  return { total: n, totalPoints, issues: await loadRows(page.map((r) => r.id), viewerId) }
}

const pageParams = (c: any, defaultMax: number, hardMax: number) => ({
  startAt: Math.max(Number(c.req.query('startAt')) || 0, 0),
  maxResults: Math.min(Math.max(Number(c.req.query('maxResults')) || defaultMax, 1), hardMax),
  q: (c.req.query('q') || '').trim().slice(0, 200) || undefined,
  includeDone: c.req.query('includeDone') === 'true',
})

app.get('/rest/agile/1.0/board/:boardId/backlog', requireAuth, async (c) => {
  const guard = await boardGuard(c); if (isResponse(guard)) return guard
  const p = pageParams(c, 50, 500)
  const res = await loadBacklog(guard.board.projectId, p, c.get('user')!.id)
  return c.json({ startAt: p.startAt, maxResults: p.maxResults, total: res.total, storyPoints: res.totalPoints, issues: res.issues })
})

/**
 * Everything the backlog page needs in three queries instead of one search per sprint:
 * sprints with their issues, counts and story points, and the first page of the backlog.
 * Closed sprints come back without issues (counts only) unless `includeClosed=true`.
 */
app.get('/rest/agile/1.0/board/:boardId/planning', requireAuth, async (c) => {
  const guard = await boardGuard(c); if (isResponse(guard)) return guard
  const { board } = guard
  const includeClosed = c.req.query('includeClosed') === 'true'
  const backlogMax = Math.min(Math.max(Number(c.req.query('backlogMax')) || 100, 1), 500)

  const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.boardId, board.id)).orderBy(asc(schema.sprints.id))
  const sprintIds = sprints.map((s) => s.id)
  const members = sprintIds.length
    ? await db.select({ sprintId: schema.sprintIssues.sprintId, issueId: schema.sprintIssues.issueId })
        .from(schema.sprintIssues).innerJoin(schema.issues, eq(schema.issues.id, schema.sprintIssues.issueId))
        .where(and(inArray(schema.sprintIssues.sprintId, sprintIds), issueVisibleSql(c.get('user')!.id)))
        .orderBy(asc(schema.sprintIssues.sortOrder), asc(schema.sprintIssues.issueId))
    : []
  const bySprint = new Map<number, number[]>()
  for (const m of members) bySprint.set(m.sprintId, [...(bySprint.get(m.sprintId) ?? []), m.issueId])

  const detailed = sprints.filter((s) => s.state !== 'closed' || includeClosed)
  const rowIds = [...new Set(detailed.flatMap((s) => bySprint.get(s.id) ?? []))]
  const allIds = [...new Set(members.map((m) => m.issueId))]
  const [rows, points, backlog] = await Promise.all([
    loadRows(rowIds, c.get('user')!.id),
    pointsByIssue(allIds),
    loadBacklog(board.projectId, { startAt: 0, maxResults: backlogMax, includeDone: false }, c.get('user')!.id),
  ])
  const rowById = new Map(rows.map((r) => [Number(r.id), r]))
  const order = { active: 0, future: 1, closed: 2 } as Record<string, number>
  const out = sprints
    .map((s) => {
      const ids = bySprint.get(s.id) ?? []
      return {
        ...serializeSprint(s),
        issueCount: ids.length,
        storyPoints: sumPoints(ids.map((id) => ({ points: points.get(id) }))),
        issues: s.state !== 'closed' || includeClosed ? ids.map((id) => rowById.get(id)).filter(Boolean) : undefined,
      }
    })
    .sort((a, b) => (order[a.state ?? 'future'] - order[b.state ?? 'future']) || (b.state === 'closed' ? b.id - a.id : a.id - b.id))

  return c.json({
    board: { id: board.id, name: board.name, type: board.type, projectId: board.projectId, allowParallelSprints: parallelSprintsAllowed(board.config), sprintAutomation: parseSprintAutomation(board.config) },
    sprints: out,
    backlog: { total: backlog.total, storyPoints: backlog.totalPoints, startAt: 0, maxResults: backlogMax, issues: backlog.issues },
  })
})

export default app
