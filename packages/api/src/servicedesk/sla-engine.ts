/**
 * Jira-style SLA clock. Pure: given an issue timeline, start/pause/stop conditions, a calendar and a goal
 * it computes elapsed working time, remaining time, state and the breach timestamp.
 *
 * Semantics (mirrors Jira Service Management):
 *  - Start/stop conditions are EVENTS. The clock starts at the first event matching a start condition.
 *    A start condition with `restart` resets the clock (elapsed back to 0, stop cleared) every time it fires again.
 *  - Pause conditions are STATES: the clock is paused while any of them holds
 *    (in status X, issue unassigned, issue resolved, last public comment was by an agent, ...).
 */
import {
  addWorkingMillis, workingMillis, workingIntervals, type Calendar, type Interval,
} from './calendar'

export type ConditionEvent =
  | 'issue_created'
  | 'status_entered'
  | 'status_exited'
  | 'comment_customer'
  | 'comment_agent'
  | 'resolution_set'
  | 'resolution_cleared'
  | 'assignee_set'
  | 'assignee_cleared'
  | 'priority_changed'
  | 'waiting_for_customer'

export const CONDITION_EVENTS: readonly ConditionEvent[] = [
  'issue_created', 'status_entered', 'status_exited', 'comment_customer', 'comment_agent',
  'resolution_set', 'resolution_cleared', 'assignee_set', 'assignee_cleared', 'priority_changed',
  'waiting_for_customer',
]

export interface SlaCondition {
  event: ConditionEvent
  /** For status_entered / status_exited. */
  statusIds?: number[]
  /** Start conditions only: restart the clock when this fires again. */
  restart?: boolean
}

export type TimelineKind =
  | 'issue_created'
  | 'status_changed'
  | 'comment_customer'
  | 'comment_agent'
  | 'resolution_set'
  | 'resolution_cleared'
  | 'assignee_set'
  | 'assignee_cleared'
  | 'priority_changed'

export interface TimelineEvent {
  at: number
  kind: TimelineKind
  /** status_changed: previous / new status. issue_created: toStatusId = initial status. */
  fromStatusId?: number | null
  toStatusId?: number | null
  /** issue_created: whether it was created assigned / already resolved. */
  assigned?: boolean
}

export type ClockStatus = 'not_started' | 'running' | 'paused' | 'warning' | 'met' | 'breached'

export interface ClockInput {
  events: TimelineEvent[]
  start: SlaCondition[]
  pause: SlaCondition[]
  stop: SlaCondition[]
  calendar: Calendar
  goalMs: number
  /** Near-breach threshold in percent of the goal (1-99); null/undefined = off. */
  warningPercent?: number | null
  now: number
  /** Status ids that count as "Waiting for customer" for the waiting_for_customer condition. */
  waitingStatusIds?: ReadonlySet<number>
}

export interface ClockResult {
  status: ClockStatus
  startedAt: number | null
  stoppedAt: number | null
  elapsedMs: number
  remainingMs: number
  goalMs: number
  paused: boolean
  breached: boolean
  /** Instant the goal is (projected to be) / was exceeded; null while paused, not started, or met. */
  breachAt: number | null
  /** Instant the warning threshold is reached; null if off or already reached/paused. */
  warningAt: number | null
}

const DAY_GUARD = 100_000

function matchesEvent(c: SlaCondition, e: TimelineEvent, waiting: ReadonlySet<number>): boolean {
  switch (c.event) {
    case 'issue_created': return e.kind === 'issue_created'
    case 'status_entered':
      return (e.kind === 'status_changed' || e.kind === 'issue_created') && e.toStatusId != null && (c.statusIds ?? []).includes(e.toStatusId)
    case 'status_exited':
      return e.kind === 'status_changed' && e.fromStatusId != null && (c.statusIds ?? []).includes(e.fromStatusId)
    case 'waiting_for_customer':
      return (e.kind === 'status_changed' || e.kind === 'issue_created') && e.toStatusId != null && waiting.has(e.toStatusId)
    case 'comment_customer': return e.kind === 'comment_customer'
    case 'comment_agent': return e.kind === 'comment_agent'
    case 'resolution_set': return e.kind === 'resolution_set'
    case 'resolution_cleared': return e.kind === 'resolution_cleared'
    case 'assignee_set': return e.kind === 'assignee_set' || (e.kind === 'issue_created' && e.assigned === true)
    case 'assignee_cleared': return e.kind === 'assignee_cleared'
    case 'priority_changed': return e.kind === 'priority_changed'
  }
}

interface IssueState {
  statusId: number | null
  assigned: boolean
  resolved: boolean
  lastComment: 'customer' | 'agent' | null
}

function applyEvent(s: IssueState, e: TimelineEvent): void {
  switch (e.kind) {
    case 'issue_created': s.statusId = e.toStatusId ?? null; s.assigned = !!e.assigned; break
    case 'status_changed': s.statusId = e.toStatusId ?? null; break
    case 'assignee_set': s.assigned = true; break
    case 'assignee_cleared': s.assigned = false; break
    case 'resolution_set': s.resolved = true; break
    case 'resolution_cleared': s.resolved = false; break
    case 'comment_customer': s.lastComment = 'customer'; break
    case 'comment_agent': s.lastComment = 'agent'; break
    default: break
  }
}

function pauseHolds(conds: SlaCondition[], s: IssueState, waiting: ReadonlySet<number>): boolean {
  for (const c of conds) {
    switch (c.event) {
      case 'status_entered': if (s.statusId != null && (c.statusIds ?? []).includes(s.statusId)) return true; break
      case 'status_exited': if (s.statusId != null && !(c.statusIds ?? []).includes(s.statusId)) return true; break
      case 'waiting_for_customer': if (s.statusId != null && waiting.has(s.statusId)) return true; break
      case 'assignee_cleared': if (!s.assigned) return true; break
      case 'assignee_set': if (s.assigned) return true; break
      case 'resolution_set': if (s.resolved) return true; break
      case 'resolution_cleared': if (!s.resolved) return true; break
      case 'comment_agent': if (s.lastComment === 'agent') return true; break
      case 'comment_customer': if (s.lastComment === 'customer') return true; break
      default: break // issue_created / priority_changed are not states
    }
  }
  return false
}

/** Merge and clip intervals to [lo, hi]. */
function clipMerge(intervals: Interval[], lo: number, hi: number): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, lo), end: Math.min(i.end, hi) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of clipped) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

function measure(cal: Calendar, from: number, to: number, pauses: Interval[]): number {
  let total = workingMillis(cal, from, to)
  for (const p of clipMerge(pauses, from, to)) total -= workingMillis(cal, p.start, p.end)
  return Math.max(0, total)
}

/** The instant at which `goalMs` of non-paused working time had accumulated in [start, end]; null if not reached. */
function reachedAt(cal: Calendar, start: number, end: number, pauses: Interval[], goalMs: number): number | null {
  let left = goalMs
  // walk working intervals, minus pauses
  let cursor = start
  const ps = clipMerge(pauses, start, end)
  const active: Interval[] = []
  for (const p of ps) { if (p.start > cursor) active.push({ start: cursor, end: p.start }); cursor = p.end }
  if (cursor < end) active.push({ start: cursor, end })
  for (const a of active) {
    for (const w of workingIntervals(cal, a.start, a.end)) {
      const len = w.end - w.start
      if (left < len) return w.start + left
      left -= len
    }
  }
  return left <= 0 ? end : null
}

export function computeSlaClock(input: ClockInput): ClockResult {
  const waiting = input.waitingStatusIds ?? new Set<number>()
  const events = [...input.events].sort((a, b) => a.at - b.at)
  const st: IssueState = { statusId: null, assigned: false, resolved: false, lastComment: null }

  let startedAt: number | null = null
  let stoppedAt: number | null = null
  let pauses: Interval[] = []
  let pauseStart: number | null = null
  let guard = 0

  for (const e of events) {
    if (guard++ > DAY_GUARD) break
    const wasPaused = pauseStart !== null
    applyEvent(st, e)

    const startHits = input.start.filter((c) => matchesEvent(c, e, waiting))
    let began = false
    if (startHits.length > 0 && (startedAt === null || startHits.some((c) => c.restart))) {
      startedAt = e.at
      stoppedAt = null
      pauses = []
      pauseStart = null
      began = true
    }

    // pause state after this event
    const paused = startedAt !== null && stoppedAt === null && pauseHolds(input.pause, st, waiting)
    if (began) {
      pauseStart = paused ? e.at : null
    } else if (paused && !wasPaused) pauseStart = e.at
    else if (!paused && wasPaused && pauseStart !== null) {
      pauses.push({ start: pauseStart, end: e.at })
      pauseStart = null
    }

    if (!began && startedAt !== null && stoppedAt === null && e.at >= startedAt && input.stop.some((c) => matchesEvent(c, e, waiting))) {
      stoppedAt = e.at
      if (pauseStart !== null) { pauses.push({ start: pauseStart, end: e.at }); pauseStart = null }
    }
  }

  const goalMs = input.goalMs
  if (startedAt === null) {
    return { status: 'not_started', startedAt: null, stoppedAt: null, elapsedMs: 0, remainingMs: goalMs, goalMs, paused: false, breached: false, breachAt: null, warningAt: null }
  }

  const end = stoppedAt ?? input.now
  const allPauses = pauseStart !== null ? [...pauses, { start: pauseStart, end }] : pauses
  const elapsedMs = end > startedAt ? measure(input.calendar, startedAt, end, allPauses) : 0
  const paused = stoppedAt === null && pauseStart !== null
  const breached = elapsedMs > goalMs
  const warnMs = input.warningPercent ? Math.floor((goalMs * input.warningPercent) / 100) : null

  let status: ClockStatus
  if (stoppedAt !== null) status = breached ? 'breached' : 'met'
  else if (breached) status = 'breached'
  else if (paused) status = 'paused'
  else if (warnMs !== null && elapsedMs >= warnMs) status = 'warning'
  else status = 'running'

  // breach / warning instants
  let breachAt: number | null = null
  let warningAt: number | null = null
  if (breached) {
    // first instant at which elapsed exceeded the goal (+1 ms so "exceeded", not "reached")
    const hit = reachedAt(input.calendar, startedAt, end, allPauses, goalMs)
    breachAt = hit
  } else if (stoppedAt === null && !paused) {
    breachAt = addWorkingMillis(input.calendar, input.now, goalMs - elapsedMs)
    if (warnMs !== null && elapsedMs < warnMs) warningAt = addWorkingMillis(input.calendar, input.now, warnMs - elapsedMs)
  }

  return {
    status, startedAt, stoppedAt, elapsedMs, remainingMs: goalMs - elapsedMs, goalMs, paused, breached, breachAt, warningAt,
  }
}

/* ------------------------------------------------------------------ */
/*  Goals                                                              */
/* ------------------------------------------------------------------ */

export interface GoalCriteria {
  priorityIds?: number[]
  issueTypeIds?: number[]
  requestTypeIds?: number[]
}

export interface GoalDef {
  id: number
  sortOrder: number
  targetMinutes: number
  criteria: GoalCriteria
  jql: string | null
  calendarId: number | null
  /** Legacy single-priority column. */
  priorityId?: number | null
}

export interface GoalIssue { priorityId: number | null; issueTypeId: number | null; requestTypeId: number | null }

export function criteriaMatch(c: GoalCriteria, issue: GoalIssue): boolean {
  if (c.priorityIds?.length && (issue.priorityId == null || !c.priorityIds.includes(issue.priorityId))) return false
  if (c.issueTypeIds?.length && (issue.issueTypeId == null || !c.issueTypeIds.includes(issue.issueTypeId))) return false
  if (c.requestTypeIds?.length && (issue.requestTypeId == null || !c.requestTypeIds.includes(issue.requestTypeId))) return false
  return true
}

/** Effective criteria: the legacy priorityId column acts as `priorityIds: [id]` when criteria is empty. */
export function effectiveCriteria(g: GoalDef): GoalCriteria {
  const c = g.criteria ?? {}
  if (!c.priorityIds?.length && g.priorityId != null) return { ...c, priorityIds: [g.priorityId] }
  return c
}

/** Goals in evaluation order: explicit order first; legacy ties resolve specific-before-default. */
export function orderGoals(goals: GoalDef[]): GoalDef[] {
  const specific = (g: GoalDef) => {
    const c = effectiveCriteria(g)
    return (c.priorityIds?.length || c.issueTypeIds?.length || c.requestTypeIds?.length || g.jql) ? 0 : 1
  }
  return [...goals].sort((a, b) => a.sortOrder - b.sortOrder || specific(a) - specific(b) || a.id - b.id)
}

/** First matching goal wins. `jqlMatch(goal)` says whether the goal's JQL accepts the issue (only called when set). */
export function pickGoal(goals: GoalDef[], issue: GoalIssue, jqlMatch: (g: GoalDef) => boolean = () => true): GoalDef | null {
  for (const g of orderGoals(goals)) {
    if (!criteriaMatch(effectiveCriteria(g), issue)) continue
    if (g.jql && !jqlMatch(g)) continue
    return g
  }
  return null
}

/** Default conditions for SLAs created before the Jira model (metric first_response | resolution). */
export function legacyConditions(metric: string, pauseStatusIds: number[]): { start: SlaCondition[]; pause: SlaCondition[]; stop: SlaCondition[] } {
  return {
    start: [{ event: 'issue_created' }],
    pause: pauseStatusIds.length ? [{ event: 'status_entered', statusIds: pauseStatusIds }] : [],
    stop: metric === 'first_response' ? [{ event: 'comment_agent' }, { event: 'resolution_set' }] : [{ event: 'resolution_set' }],
  }
}
