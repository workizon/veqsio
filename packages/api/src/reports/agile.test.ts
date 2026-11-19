import { describe, it, expect } from 'bun:test'
import { burndown, cumulativeFlow, controlChart, sprintSummary, epicProgress, doneAt, sizeFor, countUnestimated, type ReportIssue, type CategoryOf } from './agile'

const D = 86_400_000
const t = (day: number, h = 12) => Date.UTC(2026, 0, day, h)
const cat: CategoryOf = (s) => (s === 'Done' ? 'done' : s === 'In Progress' ? 'in_progress' : 'todo')
const mk = (id: number, size: number, changes: Array<[number, string]>, created = t(1)): ReportIssue => ({
  id, key: `A-${id}`, summary: `i${id}`, createdAt: created, initialStatus: 'To Do', size,
  changes: changes.map(([at, to]) => ({ at, to })),
})

describe('doneAt', () => {
  it('handles reopen', () => {
    const i = mk(1, 1, [[t(2), 'Done'], [t(3), 'In Progress']])
    expect(doneAt(i, cat)).toBeNull()
    expect(doneAt(i, cat, t(2, 18))).toBe(t(2))
  })
})

describe('burndown', () => {
  it('computes remaining per day and an ideal line', () => {
    const issues = [mk(1, 2, [[t(2), 'Done']]), mk(2, 3, [[t(4), 'Done']]), mk(3, 5, [])]
    const r = burndown({ start: t(1, 0), end: t(5, 0), now: t(3, 12), issues, cat })
    expect(r.total).toBe(10)
    expect(r.points.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'])
    expect(r.points[0].remaining).toBe(10)
    expect(r.points[1].remaining).toBe(8) // issue 1 done on day 2
    expect(r.points[2].remaining).toBe(8)
    expect(Number.isNaN(r.points[3].remaining)).toBe(true) // future
    expect(r.points[0].ideal).toBe(10)
    expect(r.points[4].ideal).toBe(0)
  })
})

describe('sprint summary', () => {
  it('splits completed and incomplete', () => {
    const s = sprintSummary([mk(1, 2, [[t(2), 'Done']]), mk(2, 3, [[t(9), 'Done']])], cat, t(5))
    expect(s).toMatchObject({ committed: 5, completed: 2, incomplete: 3, completedIssues: ['A-1'], incompleteIssues: ['A-2'] })
  })
})

describe('cumulative flow', () => {
  it('counts categories per day', () => {
    const cfd = cumulativeFlow({ from: t(1, 0), to: t(3, 0), cat, issues: [mk(1, 1, [[t(2), 'In Progress'], [t(3), 'Done']]), mk(2, 1, [], t(2))] })
    expect(cfd[0]).toMatchObject({ todo: 1, in_progress: 0, done: 0 })
    expect(cfd[1]).toMatchObject({ todo: 1, in_progress: 1, done: 0 })
    expect(cfd[2]).toMatchObject({ todo: 1, in_progress: 0, done: 1 })
  })
})

describe('control chart', () => {
  it('computes cycle time stats within the window', () => {
    const issues = [mk(1, 1, [[t(2), 'In Progress'], [t(4), 'Done']]), mk(2, 1, [[t(3), 'In Progress'], [t(9), 'Done']]), mk(3, 1, [])]
    const c = controlChart({ issues, cat, from: t(1), to: t(20) })
    expect(c.points).toHaveLength(2)
    expect(c.points[0].cycleDays).toBeCloseTo(2)
    expect(c.points[1].cycleDays).toBeCloseTo(6)
    expect(c.averageCycleDays).toBeCloseTo(4)
    expect(c.medianCycleDays).toBeCloseTo(2)
    expect(c.p85CycleDays).toBeCloseTo(6)
  })
})

describe('epics', () => {
  it('rolls up progress', () => {
    const r = epicProgress([{ key: 'E-1', summary: 'Epic' }], [
      { epicKey: 'E-1', category: 'done', size: 1 }, { epicKey: 'E-1', category: 'todo', size: 3 }, { epicKey: 'E-2', category: 'done', size: 9 },
    ])
    expect(r[0]).toMatchObject({ total: 4, done: 1, percentDone: 25 })
  })
})

describe('story points unit', () => {
  it('sizeFor maps points, hours and issues; unestimated counts as 0', () => {
    expect(sizeFor('points', { timeEstimate: null, storyPoints: '5.50' })).toEqual({ size: 5.5, estimated: true })
    expect(sizeFor('points', { timeEstimate: 3600, storyPoints: null })).toEqual({ size: 0, estimated: false })
    expect(sizeFor('points', { timeEstimate: null, storyPoints: '0.00' })).toEqual({ size: 0, estimated: true })
    expect(sizeFor('hours', { timeEstimate: 7200, storyPoints: null })).toEqual({ size: 2, estimated: true })
    expect(sizeFor('hours', { timeEstimate: null, storyPoints: 3 })).toEqual({ size: 0, estimated: false })
    expect(sizeFor('issues', { timeEstimate: null, storyPoints: null })).toEqual({ size: 1, estimated: true })
  })

  it('reports unestimated counts in burndown, sprint summary and epics', () => {
    const a = { ...mk(1, 3, [[t(2), 'Done']]), estimated: true }
    const b = { ...mk(2, 0, []), estimated: false }
    expect(countUnestimated([a, b])).toBe(1)
    expect(burndown({ start: t(1, 0), end: t(3, 0), now: t(3), issues: [a, b], cat })).toMatchObject({ total: 3, unestimated: 1 })
    expect(sprintSummary([a, b], cat, t(5))).toMatchObject({ committed: 3, completed: 3, incomplete: 0, unestimated: 1 })
    const e = epicProgress([{ key: 'E-1', summary: 'e' }], [
      { epicKey: 'E-1', category: 'done', size: 3, estimated: true },
      { epicKey: 'E-1', category: 'todo', size: 0, estimated: false },
    ])
    expect(e[0]).toMatchObject({ total: 3, done: 3, percentDone: 100, unestimated: 1 })
  })
})

describe('epicProgress with cancelled children', () => {
  it('excludes cancelled work from total and percent', () => {
    const [e] = epicProgress([{ key: 'E-1', summary: 'e' }], [
      { epicKey: 'E-1', category: 'done', size: 1 }, { epicKey: 'E-1', category: 'cancelled', size: 5 },
      { epicKey: 'E-1', category: 'todo', size: 1 },
    ])
    expect(e).toMatchObject({ total: 2, done: 1, todo: 1, percentDone: 50 })
  })
})
