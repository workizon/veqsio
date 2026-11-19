import { describe, it, expect } from 'bun:test'
import type { CategoryOf } from './agile'
import {
  burnup, intervalsFromEvents, projectCompletion, recentVelocityPerDay, releaseBurndown, scopeChanges, summarizeVersion,
  type ScopedIssue, type VersionIssueRow,
} from './burnup'

const D = 86_400_000
const t = (day: number, h = 12) => Date.UTC(2026, 0, day, h)
const cat: CategoryOf = (s) => (s === 'Done' ? 'done' : s === 'In Progress' ? 'in_progress' : 'todo')
const mk = (id: number, size: number, changes: Array<[number, string]>, intervals: ScopedIssue['intervals']): ScopedIssue => ({
  id, key: `A-${id}`, summary: `i${id}`, createdAt: t(1, 0), initialStatus: 'To Do', size,
  changes: changes.map(([at, to]) => ({ at, to })), intervals,
})

describe('intervalsFromEvents', () => {
  it('uses the fallback for members without history and nothing for non-members', () => {
    expect(intervalsFromEvents([], { currentlyMember: true, fallbackFrom: 5 })).toEqual([{ from: 5, to: null }])
    expect(intervalsFromEvents([], { currentlyMember: false, fallbackFrom: 5 })).toEqual([])
  })
  it('opens and closes on each flip, including a re-add', () => {
    const ev = [
      { at: 30, before: true, after: false },
      { at: 10, before: false, after: true },
      { at: 50, before: false, after: true },
    ]
    // sorted: add@10 (initial state out), remove@30, add@50. The first event decides the initial state: "out".
    expect(intervalsFromEvents(ev, { currentlyMember: true, fallbackFrom: 0 }))
      .toEqual([{ from: 10, to: 30 }, { from: 50, to: null }])
  })
  it('starts at the fallback when the first event is a removal', () => {
    expect(intervalsFromEvents([{ at: 20, before: true, after: false }], { currentlyMember: false, fallbackFrom: 3 }))
      .toEqual([{ from: 3, to: 20 }])
  })
  it('ignores the bookkeeping rows written at sprint completion', () => {
    expect(intervalsFromEvents([{ at: 100, before: true, after: false }], { currentlyMember: true, fallbackFrom: 3, dropFrom: 90 }))
      .toEqual([{ from: 3, to: null }])
  })
})

describe('burnup', () => {
  // Sprint Jan 1 - Jan 5. A-1 (2) and A-2 (3) committed, A-3 (5) added on Jan 3, A-2 removed on Jan 4.
  const issues = [
    mk(1, 2, [[t(2), 'Done']], [{ from: t(1, 0), to: null }]),
    mk(2, 3, [[t(3), 'Done']], [{ from: t(1, 0), to: t(4) }]),
    mk(3, 5, [[t(4, 6), 'Done'], [t(5, 6), 'In Progress']], [{ from: t(3), to: null }]),
  ]
  const r = burnup({ start: t(1, 0), end: t(5, 0), now: t(5, 18), issues, cat })

  it('has exact scope and completed series', () => {
    expect(r.points.map((p) => [p.date, p.scope, p.completed])).toEqual([
      ['2026-01-01', 5, 0],
      ['2026-01-02', 5, 2],
      ['2026-01-03', 10, 5], // A-3 joined at noon, A-2 done at noon
      ['2026-01-04', 7, 7],  // A-2 removed (out of scope and of completed), A-3 done at 06:00
      ['2026-01-05', 7, 2],  // A-3 reopened
    ])
    expect(r.initialScope).toBe(5)
    expect(r.scope).toBe(7)
    expect(r.completed).toBe(2)
  })

  it('lists scope changes after the start, oldest first', () => {
    expect(r.scopeChanges.map((c) => [c.kind, c.key, c.size])).toEqual([['added', 'A-3', 5], ['removed', 'A-2', 3]])
  })

  it('marks days after now as NaN', () => {
    const early = burnup({ start: t(1, 0), end: t(5, 0), now: t(2, 12), issues, cat })
    expect(early.points.map((p) => Number.isNaN(p.scope))).toEqual([false, false, true, true, true])
  })

  it('counts unestimated issues in the unit', () => {
    const a = { ...issues[0], estimated: false }
    expect(burnup({ start: t(1, 0), end: t(2, 0), now: t(2, 0), issues: [a], cat }).unestimated).toBe(1)
  })
})

describe('scopeChanges', () => {
  it('treats work that joined before the start as committed', () => {
    expect(scopeChanges([mk(1, 1, [], [{ from: t(1, 0), to: null }])], t(1, 0))).toEqual([])
  })
})

describe('velocity and projection', () => {
  const issues = [
    mk(1, 4, [[t(10), 'Done']], [{ from: t(1, 0), to: null }]),
    mk(2, 6, [[t(12), 'Done']], [{ from: t(1, 0), to: null }]),
    mk(3, 10, [], [{ from: t(1, 0), to: null }]),
  ]
  it('averages the completions of the lookback window', () => {
    expect(recentVelocityPerDay(issues, cat, t(14), 10)).toBe(1) // 10 done in 10 days
    expect(recentVelocityPerDay(issues, cat, t(14), 1)).toBe(0)
    expect(recentVelocityPerDay(issues, cat, t(14), 3)).toBe(2) // only the 6 point issue finished within 3 days
  })
  it('projects the completion date, or null without a pace', () => {
    expect(projectCompletion(10, 2, t(1))).toBe(t(1) + 5 * D)
    expect(projectCompletion(0, 0, t(1))).toBe(t(1))
    expect(projectCompletion(10, 0, t(1))).toBeNull()
    expect(projectCompletion(10_000, 1, t(1))).toBeNull()
  })
})

describe('releaseBurndown', () => {
  const issues = [
    mk(1, 4, [[t(10), 'Done']], [{ from: t(1, 0), to: null }]),
    mk(2, 6, [[t(12), 'Done']], [{ from: t(1, 0), to: null }]),
    mk(3, 10, [], [{ from: t(1, 0), to: null }]),
  ]
  const r = releaseBurndown({ start: t(1, 0), releaseDate: t(20, 0), now: t(14), issues, cat, lookbackDays: 10 })

  it('reports remaining work, pace and the projected date', () => {
    expect(r).toMatchObject({ scope: 20, completed: 10, remaining: 10, velocityPerDay: 1, releaseDate: '2026-01-20', projectedDate: '2026-01-24', onTrack: false, daysLate: 4 })
  })
  it('has remaining, ideal and projected series', () => {
    const byDate = Object.fromEntries(r.points.map((p) => [p.date, p]))
    expect(byDate['2026-01-01']).toMatchObject({ remaining: 20, ideal: 20, projected: null })
    expect(byDate['2026-01-10'].remaining).toBe(16)
    expect(byDate['2026-01-12'].remaining).toBe(10)
    expect(byDate['2026-01-14']).toMatchObject({ remaining: 10, projected: 10 })
    expect(byDate['2026-01-17'].projected).toBe(7)
    expect(byDate['2026-01-20'].ideal).toBe(0)
    expect(byDate['2026-01-24'].projected).toBe(0)
    expect(Number.isNaN(byDate['2026-01-15'].remaining)).toBe(true)
  })
  it('is on track when the pace finishes before the release date', () => {
    const fast = releaseBurndown({ start: t(1, 0), releaseDate: t(30, 0), now: t(14), issues, cat, lookbackDays: 10 })
    expect(fast).toMatchObject({ onTrack: true, daysLate: 0 })
  })
  it('has no verdict without velocity or release date', () => {
    const stalled = releaseBurndown({ start: t(1, 0), releaseDate: t(20, 0), now: t(14), issues, cat, lookbackDays: 1 })
    expect(stalled).toMatchObject({ velocityPerDay: 0, projectedDate: null, onTrack: null })
    expect(stalled.points.every((p) => p.projected === null || p.date === '2026-01-14')).toBe(true)
    const open = releaseBurndown({ start: t(1, 0), releaseDate: null, now: t(14), issues, cat, lookbackDays: 10 })
    expect(open.onTrack).toBeNull()
    expect(open.points[0].ideal).toBeNull()
  })
  it('is done when nothing remains', () => {
    const done = releaseBurndown({ start: t(1, 0), releaseDate: t(20, 0), now: t(14), issues: issues.slice(0, 2), cat, lookbackDays: 10 })
    expect(done).toMatchObject({ remaining: 0, onTrack: true, projectedDate: '2026-01-14' })
  })
})

describe('summarizeVersion', () => {
  const row = (key: string, status: string, category: VersionIssueRow['category'], size: number, extra: Partial<VersionIssueRow> = {}): VersionIssueRow =>
    ({ key, summary: key, status, category, type: 'Task', assignee: null, priority: null, size, estimated: size > 0, flagged: false, ...extra })
  it('counts, sums and groups by status with done last', () => {
    const s = summarizeVersion([
      row('A-10', 'Done', 'done', 5), row('A-2', 'To Do', 'todo', 3), row('A-1', 'To Do', 'todo', 0, { flagged: true }),
      row('A-3', 'In Progress', 'in_progress', 2),
    ])
    expect(s).toMatchObject({ issues: { done: 1, inProgress: 1, todo: 2, total: 4 }, completed: 5, remaining: 5, total: 10, unestimated: 1, flagged: 1 })
    expect(s.groups.map((g) => g.status)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(s.groups[0].issues.map((i) => i.key)).toEqual(['A-1', 'A-2'])
  })
})
