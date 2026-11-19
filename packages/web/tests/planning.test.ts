import { describe, test, expect } from 'bun:test'
import {
  applyCreate, applyMove, dateInputToIso, filterIssues, formatPoints, isoToDateInput, keysToMove, mapPlanning,
  matchesFilters, normalizeIssueKind, parseDropId, pointsByCategory, splitCompletion, suggestSprintName, sumPoints,
  validateSprintForm, emptyFilters, type PlanIssue, type PlanningData,
} from '../lib/planning'

const issue = (key: string, over: Partial<PlanIssue> = {}): PlanIssue => ({
  id: Number(key.split('-')[1]), key, summary: `Summary ${key}`, type: 'task', typeName: 'Task', status: 'To Do',
  category: 'todo', priority: 'Medium', storyPoints: null, ...over,
})

const data = (): PlanningData => ({
  board: { id: 1, name: 'B', type: 'scrum', projectId: 1, allowParallelSprints: true },
  sprints: [
    { id: 10, name: 'Sprint 1', state: 'active', issueCount: 2, storyPoints: 8, issues: [issue('A-1', { storyPoints: 3, category: 'done' }), issue('A-2', { storyPoints: 5 })] },
    { id: 11, name: 'Sprint 2', state: 'future', issueCount: 0, storyPoints: 0, issues: [] },
    { id: 9, name: 'Sprint 0', state: 'closed', issueCount: 4, storyPoints: 9, issues: [] },
  ],
  backlog: { total: 2, storyPoints: 3, issues: [issue('A-3', { storyPoints: 1 }), issue('A-4', { storyPoints: 2 })] },
})

describe('mapPlanning', () => {
  test('maps API rows, categories and initials', () => {
    const d = mapPlanning({
      board: { id: 1, name: 'B', type: 'scrum', projectId: 2, allowParallelSprints: true },
      sprints: [{ id: 5, name: 'S', state: 'active', issueCount: 1, storyPoints: 5, issues: [{
        id: '7', key: 'X-7', fields: {
          summary: 'Hello', status: { name: 'Done', statusCategory: { key: 'done' } }, priority: { name: 'High' },
          issuetype: { name: 'Bug' }, assignee: { displayName: 'Ada Lovelace' }, storyPoints: 5,
        },
      }] }],
      backlog: { total: 0, storyPoints: 0, issues: [] },
    })
    expect(d.sprints[0].issues[0]).toMatchObject({ id: 7, key: 'X-7', type: 'bug', category: 'done', priority: 'High', storyPoints: 5, assignee: { name: 'Ada Lovelace', initials: 'AL' } })
  })
  test('issue kinds', () => {
    expect(normalizeIssueKind('Sub-task')).toBe('sub-task')
    expect(normalizeIssueKind('Task', true)).toBe('sub-task')
    expect(normalizeIssueKind('User Story')).toBe('story')
    expect(normalizeIssueKind(undefined)).toBe('task')
  })
})

describe('points', () => {
  test('sums with missing estimates and groups by category', () => {
    const list = [issue('A-1', { storyPoints: 3, category: 'done' }), issue('A-2', { storyPoints: 0.5 }), issue('A-3')]
    expect(sumPoints(list)).toBe(3.5)
    expect(pointsByCategory(list)).toEqual({ todo: 0.5, in_progress: 0, done: 3 })
    expect(formatPoints(3)).toBe('3')
    expect(formatPoints(3.5)).toBe('3.5')
  })
})

describe('filters', () => {
  const i = issue('A-9', { summary: 'Fix login bug', assignee: { name: 'Ada', initials: 'A' }, type: 'bug' })
  test('text, assignee, type and mine', () => {
    expect(matchesFilters(i, { ...emptyFilters, text: 'LOGIN' })).toBe(true)
    expect(matchesFilters(i, { ...emptyFilters, text: 'a-9' })).toBe(true)
    expect(matchesFilters(i, { ...emptyFilters, text: 'nothing' })).toBe(false)
    expect(matchesFilters(i, { ...emptyFilters, assignee: 'unassigned' })).toBe(false)
    expect(matchesFilters(i, { ...emptyFilters, assignee: 'Ada' })).toBe(true)
    expect(matchesFilters(i, { ...emptyFilters, type: 'story' })).toBe(false)
    expect(matchesFilters(i, { ...emptyFilters, onlyMine: 'Bob' })).toBe(false)
  })
  test('filterIssues returns the same list without filters', () => {
    const list = [i]
    expect(filterIssues(list, emptyFilters)).toBe(list)
  })
})

describe('applyMove', () => {
  test('backlog to sprint updates counts and points everywhere', () => {
    const next = applyMove(data(), ['A-3', 'A-4'], { kind: 'sprint', id: 11 })
    expect(next.backlog.issues).toHaveLength(0)
    expect(next.backlog.total).toBe(0)
    expect(next.backlog.storyPoints).toBe(0)
    const s = next.sprints.find((x) => x.id === 11)!
    expect(s.issues.map((x) => x.key)).toEqual(['A-3', 'A-4'])
    expect([s.issueCount, s.storyPoints]).toEqual([2, 3])
  })
  test('sprint to sprint and sprint to backlog', () => {
    let next = applyMove(data(), ['A-2'], { kind: 'sprint', id: 11 })
    expect(next.sprints.find((x) => x.id === 10)!.issues.map((x) => x.key)).toEqual(['A-1'])
    expect(next.sprints.find((x) => x.id === 10)!.storyPoints).toBe(3)
    next = applyMove(next, ['A-1'], { kind: 'backlog' })
    expect(next.backlog.issues.map((x) => x.key)).toEqual(['A-3', 'A-4', 'A-1'])
    expect(next.backlog.total).toBe(3)
    expect(next.backlog.storyPoints).toBe(6)
  })
  test('inserts before an anchor and never mutates the input', () => {
    const before = data()
    const snapshot = JSON.stringify(before)
    const next = applyMove(before, ['A-4'], { kind: 'backlog' }, 'A-3')
    expect(next.backlog.issues.map((x) => x.key)).toEqual(['A-4', 'A-3'])
    expect(JSON.stringify(before)).toBe(snapshot)
  })
  test('ignores closed sprints and unknown keys', () => {
    const d = data()
    expect(applyMove(d, ['A-3'], { kind: 'sprint', id: 9 })).toBe(d)
    expect(applyMove(d, ['NOPE-1'], { kind: 'sprint', id: 11 })).toBe(d)
  })
})

describe('applyCreate', () => {
  test('adds to the backlog top or the end of a sprint', () => {
    const d = applyCreate(data(), issue('A-20', { storyPoints: 2 }), { kind: 'backlog' })
    expect(d.backlog.issues[0].key).toBe('A-20')
    expect(d.backlog.total).toBe(3)
    const e = applyCreate(data(), issue('A-21', { storyPoints: 2 }), { kind: 'sprint', id: 10 })
    expect(e.sprints[0].issues.at(-1)!.key).toBe('A-21')
    expect(e.sprints[0].storyPoints).toBe(10)
  })
})

describe('drag and drop ids', () => {
  test('parseDropId', () => {
    expect(parseDropId('backlog')).toEqual({ target: { kind: 'backlog' } })
    expect(parseDropId('sprint-12')).toEqual({ target: { kind: 'sprint', id: 12 } })
    expect(parseDropId('issue:A-1')).toBeNull()
    expect(parseDropId(null)).toBeNull()
  })
  test('keysToMove uses the selection only when it contains the dragged issue', () => {
    expect(keysToMove(new Set(['A-1', 'A-2']), 'A-2').sort()).toEqual(['A-1', 'A-2'])
    expect(keysToMove(new Set(['A-1']), 'A-5')).toEqual(['A-5'])
  })
})

describe('splitCompletion', () => {
  test('separates done from incomplete issues with points', () => {
    const s = splitCompletion(data().sprints[0].issues)
    expect(s.done.map((i) => i.key)).toEqual(['A-1'])
    expect(s.incomplete.map((i) => i.key)).toEqual(['A-2'])
    expect([s.donePoints, s.incompletePoints]).toEqual([3, 5])
  })
})

describe('sprint forms', () => {
  test('requires a name; dates only when starting', () => {
    expect(validateSprintForm({ name: ' ', goal: '', startDate: '', endDate: '' }).name).toBeTruthy()
    expect(validateSprintForm({ name: 'S', goal: '', startDate: '', endDate: '' })).toEqual({})
    const start = validateSprintForm({ name: 'S', goal: '', startDate: '', endDate: '' }, { requireDates: true })
    expect(start.startDate).toBeTruthy()
    expect(start.endDate).toBeTruthy()
  })
  test('end must be after start', () => {
    expect(validateSprintForm({ name: 'S', goal: '', startDate: '2026-03-10', endDate: '2026-03-10' }).endDate).toBeTruthy()
    expect(validateSprintForm({ name: 'S', goal: '', startDate: '2026-03-10', endDate: '2026-03-24' })).toEqual({})
  })
  test('date conversion round-trips in local time', () => {
    expect(isoToDateInput(dateInputToIso('2026-03-10', 'start'))).toBe('2026-03-10')
    expect(isoToDateInput(dateInputToIso('2026-03-10', 'end'))).toBe('2026-03-10')
    expect(dateInputToIso('', 'start')).toBeNull()
    expect(isoToDateInput('garbage')).toBe('')
  })
  test('suggests the next sprint name', () => {
    expect(suggestSprintName([])).toBe('Sprint 1')
    expect(suggestSprintName([{ name: 'Sprint 2' }, { name: 'Sprint 10' }, { name: 'Hotfix' }])).toBe('Sprint 11')
  })
})
