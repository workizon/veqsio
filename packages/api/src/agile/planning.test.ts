import { describe, it, expect } from 'bun:test'
import {
  normalizeIssueKeys, sumPoints, planMove, insertRank, splitForCompletion, parseMoveTarget,
  validateSprintStart, parallelSprintsAllowed, toPoints,
} from './planning'

describe('normalizeIssueKeys', () => {
  it('trims, upper-cases and de-duplicates', () => {
    expect(normalizeIssueKeys([' a-1', 'A-1', 'b-2', '', '  '])).toEqual(['A-1', 'B-2'])
  })
})

describe('sumPoints', () => {
  it('treats missing estimates as zero and avoids float noise', () => {
    expect(sumPoints([{ points: 3 }, { points: null }, {}, { points: 0.1 }, { points: 0.2 }])).toBe(3.3)
    expect(sumPoints([])).toBe(0)
  })
})

describe('planMove', () => {
  it('adds issues that are not in the target and removes them from other open sprints', () => {
    const plan = planMove([
      { issueId: 1, openSprintIds: [] },
      { issueId: 2, openSprintIds: [7] },
      { issueId: 3, openSprintIds: [9] },
    ], 9)
    expect(plan.add).toEqual([1, 2])
    expect(plan.remove).toEqual([{ issueId: 2, sprintId: 7 }])
    expect(plan.unchanged).toEqual([3])
  })
  it('moves to the backlog by removing every open membership', () => {
    const plan = planMove([{ issueId: 1, openSprintIds: [4, 5] }, { issueId: 2, openSprintIds: [] }], null)
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([{ issueId: 1, sprintId: 4 }, { issueId: 1, sprintId: 5 }])
    expect(plan.unchanged).toEqual([2])
  })
})

describe('insertRank', () => {
  it('appends without an anchor', () => {
    expect(insertRank([1, 2, 3], [9])).toEqual([1, 2, 3, 9])
  })
  it('inserts before and after an anchor', () => {
    expect(insertRank([1, 2, 3], [9], 2)).toEqual([1, 9, 2, 3])
    expect(insertRank([1, 2, 3], [9], null, 2)).toEqual([1, 2, 9, 3])
  })
  it('reorders existing members and ignores an unknown anchor', () => {
    expect(insertRank([1, 2, 3], [3], 1)).toEqual([3, 1, 2])
    expect(insertRank([1, 2, 3], [1], 42)).toEqual([2, 3, 1])
  })
  it('ignores an anchor that is itself being moved', () => {
    expect(insertRank([1, 2, 3], [2], 2)).toEqual([1, 3, 2])
  })
})

describe('splitForCompletion', () => {
  it('keeps done issues and totals points on both sides', () => {
    const s = splitForCompletion([
      { id: 1, category: 'done', points: 5 },
      { id: 2, category: 'in_progress', points: 3 },
      { id: 3, category: 'todo' },
    ])
    expect(s.completed.map((i) => i.id)).toEqual([1])
    expect(s.incomplete.map((i) => i.id)).toEqual([2, 3])
    expect(s.completedPoints).toBe(5)
    expect(s.incompletePoints).toBe(3)
  })
})

describe('parseMoveTarget', () => {
  it('accepts backlog and positive integer ids', () => {
    expect(parseMoveTarget('backlog')).toBe('backlog')
    expect(parseMoveTarget(12)).toBe(12)
    expect(parseMoveTarget('12')).toBe(12)
    expect(parseMoveTarget('0')).toBeNull()
    expect(parseMoveTarget('abc')).toBeNull()
    expect(parseMoveTarget(undefined)).toBeNull()
    expect(parseMoveTarget(1.5)).toBeNull()
  })
})

describe('validateSprintStart', () => {
  const ok = { state: 'future', name: 'S1', startDate: new Date('2026-01-01'), endDate: new Date('2026-01-14') }
  it('passes a valid future sprint', () => expect(validateSprintStart(ok)).toEqual([]))
  it('rejects non-future states, missing name/dates and inverted ranges', () => {
    expect(validateSprintStart({ ...ok, state: 'active' })).toContain('Only future sprints can be started')
    expect(validateSprintStart({ ...ok, name: ' ' })).toContain('Sprint name is required')
    expect(validateSprintStart({ ...ok, startDate: null })).toContain('Start date is required')
    expect(validateSprintStart({ ...ok, endDate: undefined })).toContain('End date is required')
    expect(validateSprintStart({ ...ok, endDate: ok.startDate })).toContain('End date must be after the start date')
  })
})

describe('parallelSprintsAllowed / toPoints', () => {
  it('defaults to allowed', () => {
    expect(parallelSprintsAllowed(undefined)).toBe(true)
    expect(parallelSprintsAllowed({})).toBe(true)
    expect(parallelSprintsAllowed({ allowParallelSprints: false })).toBe(false)
  })
  it('parses numeric strings', () => {
    expect(toPoints('8')).toBe(8)
    expect(toPoints(null)).toBeNull()
    expect(toPoints('x')).toBeNull()
  })
})

describe('splitForCompletion with cancelled issues', () => {
  it('keeps cancelled issues in the closed sprint and out of completed points', () => {
    const r = splitForCompletion([
      { id: 1, category: 'done', points: 3 }, { id: 2, category: 'cancelled', points: 8 },
      { id: 3, category: 'in_progress', points: 5 }, { id: 4, category: 'todo', points: 1 },
    ])
    expect(r.completed.map((i) => i.id)).toEqual([1])
    expect(r.cancelled.map((i) => i.id)).toEqual([2])
    expect(r.incomplete.map((i) => i.id)).toEqual([3, 4])
    expect(r.completedPoints).toBe(3)
    expect(r.incompletePoints).toBe(6)
  })
})
