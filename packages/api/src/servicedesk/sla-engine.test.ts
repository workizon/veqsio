import { describe, it, expect } from 'bun:test'
import { ALWAYS_OPEN, SAMPLE_9_TO_5, type Calendar } from './calendar'
import {
  computeSlaClock, legacyConditions, orderGoals, pickGoal,
  type GoalDef, type SlaCondition, type TimelineEvent,
} from './sla-engine'
import { buildTimeline } from './sla-timeline'

const H = 3_600_000
const M = 60_000
const utc = (d: number, h = 0, mi = 0) => Date.UTC(2026, 10, d, h, mi) // November 2026; 9th = Monday

const OPEN = 1, WAITING = 2, DONE = 3

const created = (at: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ at, kind: 'issue_created', toStatusId: OPEN, ...extra })
const toStatus = (at: number, to: number, from = OPEN): TimelineEvent => ({ at, kind: 'status_changed', fromStatusId: from, toStatusId: to })
const ev = (at: number, kind: TimelineEvent['kind']): TimelineEvent => ({ at, kind })

const base = {
  start: [{ event: 'issue_created' }] as SlaCondition[],
  pause: [] as SlaCondition[],
  stop: [{ event: 'resolution_set' }] as SlaCondition[],
  calendar: SAMPLE_9_TO_5,
  goalMs: 4 * H,
}

describe('working hours', () => {
  const cases: Array<[string, Calendar, number, number, number, string, number]> = [
    // name, calendar, createdAt, now, goal ms, expected status, expected elapsed
    ['within a day', SAMPLE_9_TO_5, utc(9, 10), utc(9, 12), 4 * H, 'running', 2 * H],
    ['created before opening', SAMPLE_9_TO_5, utc(9, 3), utc(9, 10), 4 * H, 'running', 1 * H],
    ['across the night', SAMPLE_9_TO_5, utc(9, 16), utc(10, 10), 4 * H, 'running', 2 * H],
    ['across the weekend', SAMPLE_9_TO_5, utc(13, 16), utc(16, 10), 4 * H, 'running', 2 * H],
    ['breached over a weekend', SAMPLE_9_TO_5, utc(13, 16), utc(16, 14), 4 * H, 'breached', 6 * H],
    ['24/7 does not care', ALWAYS_OPEN, utc(13, 16), utc(16, 10), 4 * H, 'breached', 66 * H],
    ['holiday day not counted', { ...SAMPLE_9_TO_5, holidays: [{ date: '2026-11-10' }] }, utc(9, 16), utc(11, 10), 4 * H, 'running', 1 * H + 1 * H],
  ]
  for (const [name, calendar, c, now, goalMs, status, elapsed] of cases) {
    it(name, () => {
      const r = computeSlaClock({ ...base, calendar, goalMs, now, events: [created(c)] })
      expect(r.status).toBe(status as any)
      expect(r.elapsedMs).toBe(elapsed)
    })
  }

  it('multi-interval day and time zone', () => {
    const cal: Calendar = { timeZone: 'Europe/Berlin', days: { mon: [['08:00', '12:00'], ['13:00', '17:00']] } }
    // Berlin = UTC+1: 07-11 and 12-16 UTC. Created 10:00 UTC, now 13:00 UTC: 1h + 1h
    const r = computeSlaClock({ ...base, calendar: cal, now: utc(9, 13), events: [created(utc(9, 10))] })
    expect(r.elapsedMs).toBe(2 * H)
  })

  it('breach timestamp skips non-working time', () => {
    // created Mon 15:00 with 4h goal: 2h Mon, 2h Tue -> breach Tue 11:00
    const r = computeSlaClock({ ...base, now: utc(9, 16), events: [created(utc(9, 15))] })
    expect(r.status).toBe('running')
    expect(r.breachAt).toBe(utc(10, 11))
  })

  it('breach timestamp of an already breached running SLA is the moment the goal was exceeded', () => {
    const r = computeSlaClock({ ...base, now: utc(10, 16), events: [created(utc(9, 15))] })
    expect(r.status).toBe('breached')
    expect(r.breachAt).toBe(utc(10, 11))
  })

  it('DST safe: a goal in New York across the fall-back weekend', () => {
    const cal: Calendar = { ...SAMPLE_9_TO_5, timeZone: 'America/New_York' }
    // Fri 2026-10-30 16:00 EDT = 20:00 UTC, goal 2h: 1h Fri + 1h Mon (Nov 2, EST 9-10 = 14-15 UTC)
    const r = computeSlaClock({ ...base, calendar: cal, goalMs: 2 * H, now: Date.UTC(2026, 9, 30, 20), events: [created(Date.UTC(2026, 9, 30, 20))] })
    expect(r.breachAt).toBe(Date.UTC(2026, 10, 2, 15))
  })
})

describe('pause and resume', () => {
  const pauseWaiting: SlaCondition[] = [{ event: 'status_entered', statusIds: [WAITING] }]
  it('time in a pause status does not count', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: pauseWaiting, now: utc(9, 12),
      events: [created(utc(9, 0)), toStatus(utc(9, 2), WAITING), toStatus(utc(9, 5), OPEN, WAITING)],
    })
    expect(r.elapsedMs).toBe(9 * H)
    expect(r.paused).toBe(false)
  })
  it('stays paused when still waiting', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: pauseWaiting, now: utc(9, 12),
      events: [created(utc(9, 0)), toStatus(utc(9, 2), WAITING)],
    })
    expect(r.status).toBe('paused')
    expect(r.elapsedMs).toBe(2 * H)
    expect(r.breachAt).toBeNull()
  })
  it('pause during non-working hours costs nothing extra', () => {
    const r = computeSlaClock({
      ...base, pause: pauseWaiting, now: utc(10, 12),
      events: [created(utc(9, 15)), toStatus(utc(9, 16), WAITING), toStatus(utc(10, 8), OPEN, WAITING)],
    })
    // Mon 15-16 (1h) + Tue 9-12 (3h)
    expect(r.elapsedMs).toBe(4 * H)
  })
  it('created in a pause status is paused from the start', () => {
    const r = computeSlaClock({ ...base, calendar: ALWAYS_OPEN, pause: pauseWaiting, now: utc(9, 5), events: [created(utc(9, 0), { toStatusId: WAITING }), toStatus(utc(9, 3), OPEN, WAITING)] })
    expect(r.elapsedMs).toBe(2 * H)
  })
  it('waiting_for_customer condition uses the waiting status set', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: [{ event: 'waiting_for_customer' }], waitingStatusIds: new Set([WAITING]), now: utc(9, 6),
      events: [created(utc(9, 0)), toStatus(utc(9, 2), WAITING)],
    })
    expect(r.status).toBe('paused')
  })
  it('pause on unassigned', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: [{ event: 'assignee_cleared' }], now: utc(9, 10),
      events: [created(utc(9, 0)), ev(utc(9, 3), 'assignee_set'), ev(utc(9, 5), 'assignee_cleared'), ev(utc(9, 8), 'assignee_set')],
    })
    // paused 0-3 (unassigned at creation), 5-8
    expect(r.elapsedMs).toBe(2 * H + 2 * H)
  })
  it('agent comment pauses until the customer replies', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: [{ event: 'comment_agent' }], now: utc(9, 10),
      events: [created(utc(9, 0)), ev(utc(9, 2), 'comment_agent'), ev(utc(9, 6), 'comment_customer')],
    })
    expect(r.elapsedMs).toBe(2 * H + 4 * H)
  })
})

describe('first response by an agent', () => {
  const frt = { ...base, calendar: ALWAYS_OPEN, stop: [{ event: 'comment_agent' }] as SlaCondition[], goalMs: 1 * H }
  it('customer comments never stop the clock', () => {
    const r = computeSlaClock({ ...frt, now: utc(9, 2), events: [created(utc(9, 0)), ev(utc(9, 0, 30), 'comment_customer')] })
    expect(r.status).toBe('breached')
    expect(r.stoppedAt).toBeNull()
  })
  it('agent comment stops it and the SLA is met', () => {
    const r = computeSlaClock({ ...frt, now: utc(9, 5), events: [created(utc(9, 0)), ev(utc(9, 0, 30), 'comment_customer'), ev(utc(9, 0, 40), 'comment_agent')] })
    expect(r.status).toBe('met')
    expect(r.elapsedMs).toBe(40 * M)
    expect(r.stoppedAt).toBe(utc(9, 0, 40))
    expect(r.breachAt).toBeNull()
  })
  it('late agent comment is breached, with breach time', () => {
    const r = computeSlaClock({ ...frt, now: utc(9, 5), events: [created(utc(9, 0)), ev(utc(9, 3), 'comment_agent')] })
    expect(r.status).toBe('breached')
    expect(r.breachAt).toBe(utc(9, 1))
  })
  it('timeline builder: reporter comments are customer, others agent; internal notes are excluded by the caller', () => {
    const events = buildTimeline({
      issue: { createdAt: utc(9, 0), statusId: OPEN, assigneeId: null, reporterId: 7, resolved: false, resolvedAt: null, updatedAt: null },
      history: [], comments: [{ at: utc(9, 1), authorId: 7 }, { at: utc(9, 2), authorId: 8 }], statusIdByName: () => null,
    })
    expect(events.map((e) => e.kind)).toEqual(['issue_created', 'comment_customer', 'comment_agent'])
    const r = computeSlaClock({ ...frt, now: utc(9, 5), events })
    expect(r.stoppedAt).toBe(utc(9, 2))
  })
})

describe('stop on resolution', () => {
  it('resolution stops and freezes elapsed', () => {
    const r = computeSlaClock({ ...base, calendar: ALWAYS_OPEN, now: utc(12), events: [created(utc(9, 0)), ev(utc(9, 3), 'resolution_set')] })
    expect(r.status).toBe('met')
    expect(r.elapsedMs).toBe(3 * H)
  })
  it('resolving over the goal is breached', () => {
    const r = computeSlaClock({ ...base, calendar: ALWAYS_OPEN, now: utc(12), events: [created(utc(9, 0)), ev(utc(9, 6), 'resolution_set')] })
    expect(r.status).toBe('breached')
    expect(r.breached).toBe(true)
  })
  it('stop while paused does not count the pause', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, pause: [{ event: 'status_entered', statusIds: [WAITING] }], now: utc(12),
      events: [created(utc(9, 0)), toStatus(utc(9, 1), WAITING), ev(utc(9, 9), 'resolution_set')],
    })
    expect(r.elapsedMs).toBe(1 * H)
    expect(r.status).toBe('met')
  })
  it('resolved without history is synthesised by the timeline builder', () => {
    const events = buildTimeline({
      issue: { createdAt: utc(9, 0), statusId: DONE, assigneeId: null, reporterId: 7, resolved: true, resolvedAt: utc(9, 2), updatedAt: null },
      history: [], comments: [], statusIdByName: () => null,
    })
    expect(computeSlaClock({ ...base, calendar: ALWAYS_OPEN, now: utc(12), events }).stoppedAt).toBe(utc(9, 2))
  })
  it('status_entered as stop condition', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, stop: [{ event: 'status_entered', statusIds: [DONE] }], now: utc(12),
      events: [created(utc(9, 0)), toStatus(utc(9, 1), DONE)],
    })
    expect(r.status).toBe('met')
  })
})

describe('restart', () => {
  const cond: SlaCondition[] = [{ event: 'issue_created' }, { event: 'status_entered', statusIds: [OPEN], restart: true }]
  it('re-entering the start status resets elapsed', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, start: cond, now: utc(9, 10),
      events: [created(utc(9, 0)), toStatus(utc(9, 2), DONE, OPEN), toStatus(utc(9, 6), OPEN, DONE)],
    })
    expect(r.startedAt).toBe(utc(9, 6))
    expect(r.elapsedMs).toBe(4 * H)
  })
  it('restart after stop re-opens the clock', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, start: cond, goalMs: 10 * H, now: utc(9, 10),
      events: [created(utc(9, 0)), ev(utc(9, 1), 'resolution_set'), toStatus(utc(9, 4), OPEN, DONE)],
    })
    expect(r.stoppedAt).toBeNull()
    expect(r.status).toBe('running')
    expect(r.elapsedMs).toBe(6 * H)
  })
  it('without the restart flag a second start event is ignored', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, start: [{ event: 'status_entered', statusIds: [OPEN] }], now: utc(9, 10),
      events: [created(utc(9, 0)), toStatus(utc(9, 6), OPEN, DONE)],
    })
    expect(r.startedAt).toBe(utc(9, 0))
    expect(r.elapsedMs).toBe(10 * H)
  })
  it('pauses before a restart are forgotten', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, start: cond, pause: [{ event: 'status_entered', statusIds: [WAITING] }], now: utc(9, 10),
      events: [created(utc(9, 0)), toStatus(utc(9, 1), WAITING), toStatus(utc(9, 3), OPEN, WAITING), toStatus(utc(9, 5), OPEN, DONE)],
    })
    expect(r.elapsedMs).toBe(5 * H)
  })
  it('custom start: SLA that only starts when a customer comments', () => {
    const r = computeSlaClock({
      ...base, calendar: ALWAYS_OPEN, start: [{ event: 'comment_customer' }], now: utc(9, 10),
      events: [created(utc(9, 0)), ev(utc(9, 4), 'comment_customer')],
    })
    expect(r.elapsedMs).toBe(6 * H)
    expect(computeSlaClock({ ...base, start: [{ event: 'comment_customer' }], now: utc(9, 10), events: [created(utc(9, 0))] }).status).toBe('not_started')
  })
})

describe('warning state', () => {
  it('warns at the configured percentage and gives the warning time', () => {
    const args = { ...base, calendar: ALWAYS_OPEN, warningPercent: 75, goalMs: 4 * H }
    const early = computeSlaClock({ ...args, now: utc(9, 2), events: [created(utc(9, 0))] })
    expect(early.status).toBe('running')
    expect(early.warningAt).toBe(utc(9, 3))
    expect(computeSlaClock({ ...args, now: utc(9, 3), events: [created(utc(9, 0))] }).status).toBe('warning')
    expect(computeSlaClock({ ...args, now: utc(9, 4, 1), events: [created(utc(9, 0))] }).status).toBe('breached')
  })
  it('no warning without a threshold', () => {
    expect(computeSlaClock({ ...base, calendar: ALWAYS_OPEN, now: utc(9, 3, 59), events: [created(utc(9, 0))] }).status).toBe('running')
  })
})

describe('goals', () => {
  const g = (id: number, extra: Partial<GoalDef>): GoalDef => ({ id, sortOrder: id, targetMinutes: 60, criteria: {}, jql: null, calendarId: null, ...extra })
  const issue = { priorityId: 2, issueTypeId: 5, requestTypeId: 9 }
  it('first matching goal wins, final default catches the rest', () => {
    const goals = [g(1, { criteria: { priorityIds: [1] }, targetMinutes: 10 }), g(2, { criteria: { priorityIds: [2], issueTypeIds: [4] }, targetMinutes: 20 }),
      g(3, { criteria: { priorityIds: [2, 3] }, targetMinutes: 30 }), g(4, { targetMinutes: 99 })]
    expect(pickGoal(goals, issue)!.id).toBe(3)
    expect(pickGoal(goals, { ...issue, priorityId: 7 })!.id).toBe(4)
    expect(pickGoal(goals, { ...issue, priorityId: 1 })!.id).toBe(1)
  })
  it('order matters', () => {
    const goals = [g(1, { sortOrder: 2, criteria: { priorityIds: [2] } }), g(2, { sortOrder: 1, criteria: { requestTypeIds: [9] } })]
    expect(pickGoal(goals, issue)!.id).toBe(2)
  })
  it('jql filter is consulted', () => {
    const goals = [g(1, { jql: 'labels = vip' }), g(2, {})]
    expect(pickGoal(goals, issue, () => false)!.id).toBe(2)
    expect(pickGoal(goals, issue, () => true)!.id).toBe(1)
  })
  it('legacy priority column and null default are honoured', () => {
    const goals = [g(1, { sortOrder: 0, priorityId: null }), g(2, { sortOrder: 0, priorityId: 2 })]
    expect(orderGoals(goals).map((x) => x.id)).toEqual([2, 1])
    expect(pickGoal(goals, issue)!.id).toBe(2)
    expect(pickGoal(goals, { ...issue, priorityId: 8 })!.id).toBe(1)
  })
  it('no goal when nothing matches', () => {
    expect(pickGoal([g(1, { criteria: { priorityIds: [1] } })], issue)).toBeNull()
  })
})

describe('legacy conditions', () => {
  it('first_response stops on agent comment or resolution', () => {
    const l = legacyConditions('first_response', [])
    expect(l.stop.map((c) => c.event)).toEqual(['comment_agent', 'resolution_set'])
  })
  it('resolution pauses on legacy statuses', () => {
    const l = legacyConditions('resolution', [WAITING])
    expect(l.pause).toEqual([{ event: 'status_entered', statusIds: [WAITING] }])
    const r = computeSlaClock({ ...l, calendar: ALWAYS_OPEN, goalMs: H, now: utc(9, 10), events: [created(utc(9, 0)), toStatus(utc(9, 0, 30), WAITING)] })
    expect(r.status).toBe('paused')
  })
})
