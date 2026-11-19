import { isDoneLike } from '../workflow/status-groups'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { and, eq, inArray, asc } from 'drizzle-orm'
import { checkGlobalPermission, checkProjectPermission } from '../middleware/permissions'
import { DEFAULT_BUSINESS_HOURS, type BusinessHours, type SlaResult } from './sla'
import { ALWAYS_OPEN, calendarFromBusinessHours, type Calendar } from './calendar'
import { loadDeskCalendars } from './calendar-store'
import { evaluateGoalJql } from './goal-filter'
import {
  computeSlaClock, legacyConditions, pickGoal, type GoalCriteria, type GoalDef, type SlaCondition,
} from './sla-engine'
import { buildTimeline } from './sla-timeline'

type User = typeof schema.users.$inferSelect
type Desk = typeof schema.serviceDesks.$inferSelect

export type DeskRole = 'admin' | 'agent' | 'customer' | 'none'

/** Resolve a user's role on a desk. Deny by default. */
export async function getDeskRole(user: User | null, desk: Desk): Promise<DeskRole> {
  if (!user) return 'none'
  if (await checkGlobalPermission(user, 'ADMINISTER')) return 'admin'
  if (await checkProjectPermission(user, desk.projectId, 'ADMINISTER_PROJECTS')) return 'admin'
  const [agent] = await db.select().from(schema.serviceDeskAgents)
    .where(and(eq(schema.serviceDeskAgents.serviceDeskId, desk.id), eq(schema.serviceDeskAgents.userId, user.id)))
    .limit(1)
  if (agent) return agent.role === 'admin' ? 'admin' : 'agent'
  const [cust] = await db.select().from(schema.serviceDeskCustomers)
    .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, desk.id), eq(schema.serviceDeskCustomers.userId, user.id)))
    .limit(1)
  if (cust) return 'customer'
  return 'none'
}

export const isStaff = (r: DeskRole) => r === 'admin' || r === 'agent'

/** Public self-signup desks auto-enrol authenticated users as customers. */
export async function ensureCustomer(user: User, desk: Desk): Promise<boolean> {
  const role = await getDeskRole(user, desk)
  if (role !== 'none') return true
  if (!desk.publicSignup) return false
  await db.insert(schema.serviceDeskCustomers)
    .values({ serviceDeskId: desk.id, userId: user.id })
    .onConflictDoNothing()
  return true
}

// Form engine (field types, visibility, validation, mapping) lives in form.ts; re-exported for existing importers.
export { validateFieldValues, renderDescription, type FieldDef } from './form'

/**
 * Compute SLA results for many issues of one desk in a handful of queries.
 * Uses the Jira-style model (conditions, goals with criteria, calendars); SLAs created before it
 * (empty conditions, calendar = '24x7' | 'business', pauseStatusIds, per-priority goals) behave as before.
 */
export async function computeSlas(desk: Desk, issueIds: number[], now = Date.now()): Promise<Map<number, SlaResult[]>> {
  const result = new Map<number, SlaResult[]>()
  if (issueIds.length === 0) return result

  const slas = await db.select().from(schema.slaDefinitions)
    .where(eq(schema.slaDefinitions.serviceDeskId, desk.id)).orderBy(asc(schema.slaDefinitions.sortOrder), asc(schema.slaDefinitions.id))
  if (slas.length === 0) return result

  const [goalRows, issueRows, statusRows, commentRows, historyRows, requestRows, calendars] = await Promise.all([
    db.select().from(schema.slaGoals).where(inArray(schema.slaGoals.slaId, slas.map((s) => s.id))),
    db.select().from(schema.issues).where(inArray(schema.issues.id, issueIds)),
    db.select().from(schema.statuses),
    db.select({ issueId: schema.comments.issueId, authorId: schema.comments.authorId, createdAt: schema.comments.createdAt })
      .from(schema.comments)
      .where(and(inArray(schema.comments.issueId, issueIds), eq(schema.comments.isInternal, false)))
      .orderBy(asc(schema.comments.createdAt)),
    db.select().from(schema.issueHistory)
      .where(and(inArray(schema.issueHistory.issueId, issueIds), inArray(schema.issueHistory.fieldName, ['status', 'assignee', 'resolution', 'priority'])))
      .orderBy(asc(schema.issueHistory.createdAt)),
    db.select({ issueId: schema.serviceRequests.issueId, requestTypeId: schema.serviceRequests.requestTypeId })
      .from(schema.serviceRequests).where(inArray(schema.serviceRequests.issueId, issueIds)),
    loadDeskCalendars(desk.id),
  ])

  const statusById = new Map(statusRows.map((s) => [s.id, s]))
  const statusIdByName = new Map<string, number>()
  for (const s of statusRows) if (!statusIdByName.has(s.name)) statusIdByName.set(s.name, s.id)
  const waitingStatusIds = new Set(statusRows.filter((s) => s.name.trim().toLowerCase() === 'waiting for customer').map((s) => s.id))
  const legacyHours = (desk.businessHours as BusinessHours | null) ?? DEFAULT_BUSINESS_HOURS
  const reqTypeByIssue = new Map(requestRows.map((r) => [r.issueId, r.requestTypeId]))

  const goalDefs = new Map<number, GoalDef[]>()
  for (const g of goalRows) {
    const list = goalDefs.get(g.slaId) ?? []
    list.push({
      id: g.id, sortOrder: g.sortOrder, targetMinutes: g.targetMinutes, criteria: (g.criteria ?? {}) as GoalCriteria,
      jql: g.jql, calendarId: g.calendarId, priorityId: g.priorityId,
    })
    goalDefs.set(g.slaId, list)
  }
  const jqlHits = await evaluateGoalJql(goalRows.map((g) => g.jql).filter((j): j is string => !!j), issueIds)

  const calendarFor = (sla: typeof slas[number], goal: GoalDef): { name: string | null; calendar: Calendar } => {
    const id = goal.calendarId ?? sla.calendarId
    const found = id != null ? calendars.get(id) : undefined
    if (found) return { name: found.name, calendar: found.calendar }
    // legacy fallback (calendar column / desk business hours)
    if (sla.calendar === 'business') return { name: 'Business hours', calendar: calendarFromBusinessHours(legacyHours) }
    return { name: '24/7', calendar: ALWAYS_OPEN }
  }

  for (const issue of issueRows) {
    const created = issue.createdAt ? issue.createdAt.getTime() : now
    const cat = statusById.get(issue.statusId)?.category
    const resolved = !!(issue.resolutionId || issue.resolvedAt || isDoneLike(cat))
    const timeline = buildTimeline({
      issue: {
        createdAt: created, statusId: issue.statusId, assigneeId: issue.assigneeId, reporterId: issue.reporterId, resolved,
        resolvedAt: issue.resolvedAt?.getTime() ?? null, updatedAt: issue.updatedAt?.getTime() ?? null,
      },
      history: historyRows.filter((h) => h.issueId === issue.id)
        .map((h) => ({ field: h.fieldName, at: h.createdAt ? h.createdAt.getTime() : now, oldValue: h.oldValue, newValue: h.newValue })),
      comments: commentRows.filter((c) => c.issueId === issue.id).map((c) => ({ at: c.createdAt ? c.createdAt.getTime() : now, authorId: c.authorId })),
      statusIdByName: (n) => (n == null ? null : statusIdByName.get(n) ?? null),
    })
    const gi = { priorityId: issue.priorityId, issueTypeId: issue.issueTypeId, requestTypeId: reqTypeByIssue.get(issue.id) ?? null }
    const list: SlaResult[] = []

    for (const sla of slas) {
      const goal = pickGoal(goalDefs.get(sla.id) ?? [], gi, (g) => !!g.jql && !!jqlHits.get(g.jql)?.has(issue.id))
      if (!goal) continue

      const legacy = legacyConditions(sla.metric, (sla.pauseStatusIds as number[]) ?? [])
      const sc = (sla.startConditions as SlaCondition[]) ?? []
      const pc = (sla.pauseConditions as SlaCondition[]) ?? []
      const tc = (sla.stopConditions as SlaCondition[]) ?? []
      const cal = calendarFor(sla, goal)
      const clock = computeSlaClock({
        events: timeline,
        start: sc.length ? sc : legacy.start,
        // legacy pauseStatusIds act as an implicit pause condition while the new list is empty
        pause: pc.length ? pc : legacy.pause,
        stop: tc.length ? tc : legacy.stop,
        calendar: cal.calendar, goalMs: goal.targetMinutes * 60_000, warningPercent: sla.warningPercent, now, waitingStatusIds,
      })
      if (clock.status === 'not_started') continue
      const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString())
      list.push({
        slaId: sla.id, name: sla.name, metric: sla.metric, targetMs: clock.goalMs, elapsedMs: clock.elapsedMs,
        remainingMs: clock.remainingMs, status: clock.status, breached: clock.breached, stoppedAt: iso(clock.stoppedAt),
        startedAt: iso(clock.startedAt), dueAt: iso(clock.breachAt), warningAt: iso(clock.warningAt),
        goalId: goal.id, calendar: cal.name, paused: clock.paused,
      })
    }
    result.set(issue.id, list)
  }
  return result
}

/** For generic issue endpoints: is the issue a service request, and may this user see agent-only content? */
export async function issueDeskAccess(user: User | null, issueId: number): Promise<{ isRequest: boolean; staff: boolean; customerId: number | null }> {
  const [req] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issueId)).limit(1)
  if (!req) return { isRequest: false, staff: true, customerId: null }
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, req.serviceDeskId)).limit(1)
  const role = desk ? await getDeskRole(user, desk) : 'none'
  return { isRequest: true, staff: isStaff(role), customerId: req.customerId }
}
