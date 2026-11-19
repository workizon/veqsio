import { describe, test, expect } from 'bun:test'
import { buildParams, emptyForm, mergeRetry, mergeUndoResults, parseLabels, projectsOf, summarizeResult, undoGroups, type BulkResult } from '../lib/bulk'

const res = (over: Partial<BulkResult>): BulkResult => ({ operation: 'assign', total: 0, succeeded: [], failed: [], ...over })

describe('summarizeResult', () => {
  test('all succeeded', () => {
    const s = summarizeResult(res({ succeeded: ['A-1', 'A-2'] }))
    expect(s).toMatchObject({ tone: 'success', headline: '2 issues assigned.', failed: 0, canRetry: false })
  })
  test('singular wording', () => {
    expect(summarizeResult(res({ operation: 'delete', succeeded: ['A-1'] })).headline).toBe('1 issue deleted.')
  })
  test('partial success offers retry and groups reasons', () => {
    const s = summarizeResult(res({ succeeded: ['A-1'], failed: [{ key: 'A-2', reason: 'Forbidden' }, { key: 'A-3', reason: 'Forbidden' }] }))
    expect(s.tone).toBe('warning')
    expect(s.headline).toBe('1 of 3 issues assigned; 2 failed.')
    expect(s.canRetry).toBe(true)
    expect(s.failedKeys).toEqual(['A-2', 'A-3'])
    expect(s.groups).toEqual([{ reason: 'Forbidden', count: 2, keys: ['A-2', 'A-3'] }])
  })
  test('everything failed is an error', () => {
    const s = summarizeResult(res({ operation: 'transition', failed: [{ key: 'A-1', reason: 'x' }] }))
    expect(s.tone).toBe('error')
    expect(s.headline).toBe('No issues were transitioned; 1 failed.')
  })
  test('preview wording never claims changes and has no retry', () => {
    const s = summarizeResult(res({ preview: true, succeeded: ['A-1', 'A-2'], failed: [{ key: 'A-3', reason: 'n/a' }] }))
    expect(s.headline).toBe('2 of 3 issues can be changed; 1 would fail.')
    expect(s.canRetry).toBe(false)
    expect(s.canUndo).toBe(false)
  })
  test('undo only for undoable operations that returned old values', () => {
    const undo = [{ operation: 'assign' as const, issueKeys: ['A-1'], params: { assigneeId: null } }]
    expect(summarizeResult(res({ succeeded: ['A-1'], undo })).canUndo).toBe(true)
    expect(summarizeResult(res({ succeeded: ['A-1'] })).canUndo).toBe(false)
    expect(summarizeResult(res({ operation: 'delete', succeeded: ['A-1'], undo })).canUndo).toBe(false)
    expect(summarizeResult(res({ operation: 'transition', succeeded: ['A-1'], undo })).canUndo).toBe(false)
  })
  test('empty selection', () => {
    expect(summarizeResult(res({})).headline).toBe('Nothing to do.')
  })
})

describe('mergeRetry', () => {
  test('retried successes move to succeeded, remaining failures are replaced', () => {
    const prev = res({ succeeded: ['A-1'], failed: [{ key: 'A-2', reason: 'x' }, { key: 'A-3', reason: 'y' }] })
    const merged = mergeRetry(prev, res({ succeeded: ['A-2'], failed: [{ key: 'A-3', reason: 'still' }] }))
    expect(merged.succeeded).toEqual(['A-1', 'A-2'])
    expect(merged.failed).toEqual([{ key: 'A-3', reason: 'still' }])
  })
  test('undo information of both runs is kept', () => {
    const g1 = { operation: 'priority' as const, issueKeys: ['A-1'], params: { priorityId: 1 } }
    const g2 = { operation: 'priority' as const, issueKeys: ['A-2'], params: { priorityId: 1 } }
    expect(mergeRetry(res({ undo: [g1] }), res({ undo: [g2] })).undo).toEqual([g1, g2])
  })
})

describe('undo helpers', () => {
  test('undoGroups drops issues that did not succeed', () => {
    const r = res({ succeeded: ['A-1'], failed: [{ key: 'A-2', reason: 'x' }], undo: [{ operation: 'label', issueKeys: ['A-1', 'A-2'], params: { set: [] } }, { operation: 'label', issueKeys: ['A-2'], params: { set: ['x'] } }] })
    expect(undoGroups(r)).toEqual([{ operation: 'label', issueKeys: ['A-1'], params: { set: [] } }])
  })
  test('mergeUndoResults sums', () => {
    expect(mergeUndoResults([res({ succeeded: ['A-1', 'A-2'] }), res({ succeeded: ['A-3'], failed: [{ key: 'A-4', reason: 'x' }] })])).toEqual({ restored: 3, failed: 1 })
  })
})

describe('buildParams', () => {
  const f = emptyForm
  test('incomplete forms give null', () => {
    expect(buildParams('transition', f())).toBeNull()
    expect(buildParams('assign', f())).toBeNull()
    expect(buildParams('priority', f())).toBeNull()
    expect(buildParams('label', f())).toBeNull()
    expect(buildParams('move', f())).toBeNull()
    expect(buildParams('sprint', f())).toBeNull()
    expect(buildParams('edit', f())).toBeNull()
    expect(buildParams('delete', f())).toBeNull()
  })
  test('assign supports unassign (null)', () => {
    expect(buildParams('assign', { ...f(), assigneeId: null })).toEqual({ assigneeId: null })
    expect(buildParams('assign', { ...f(), assigneeId: 7 })).toEqual({ assigneeId: 7 })
  })
  test('transition with comment and resolution', () => {
    expect(buildParams('transition', { ...f(), transitionId: 3, comment: ' hi ', resolutionId: 2 })).toEqual({ transitionId: 3, fields: { resolution: { id: 2 } }, comment: 'hi' })
  })
  test('labels and id lists use the chosen mode; set may be empty', () => {
    expect(buildParams('label', { ...f(), labels: ['a'], labelMode: 'remove' })).toEqual({ remove: ['a'] })
    expect(buildParams('label', { ...f(), labelMode: 'set' })).toEqual({ set: [] })
    expect(buildParams('fixVersion', { ...f(), ids: [1, 2] })).toEqual({ add: [1, 2] })
    expect(buildParams('component', { ...f(), ids: [], listMode: 'set' })).toEqual({ set: [] })
  })
  test('sprint null means backlog', () => {
    expect(buildParams('sprint', { ...f(), sprintId: null })).toEqual({ sprintId: null })
  })
  test('edit validates date and story points, clear flags win', () => {
    expect(buildParams('edit', { ...f(), dueDate: '2030-02-01', storyPoints: '3.5' })).toEqual({ fields: { duedate: '2030-02-01', storyPoints: 3.5 } })
    expect(buildParams('edit', { ...f(), dueDate: 'tomorrow', storyPoints: '-1' })).toBeNull()
    expect(buildParams('edit', { ...f(), dueDate: '2030-02-01', clearDueDate: true, clearStoryPoints: true })).toEqual({ fields: { duedate: null, storyPoints: null } })
  })
  test('delete needs the confirmation', () => {
    expect(buildParams('delete', { ...f(), confirmDelete: true })).toEqual({})
    expect(buildParams('watch', f())).toEqual({})
  })
})

describe('misc', () => {
  test('parseLabels splits on commas and spaces and dedupes', () => {
    expect(parseLabels('a, b  c,a,')).toEqual(['a', 'b', 'c'])
    expect(parseLabels('')).toEqual([])
  })
  test('projectsOf', () => {
    expect(projectsOf(['TEST-1', 'TEST-22', 'MY-PROJ-3'])).toEqual(['TEST', 'MY-PROJ'])
  })
})
