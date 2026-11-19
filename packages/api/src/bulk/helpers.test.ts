import { describe, test, expect } from 'bun:test'
import {
  applyListChange, groupFailures, groupUndo, mergeTransitions, normalizeIssueKeys, parseBulkParams, reasonFromBody, sameList, MAX_BULK_ISSUES,
} from './helpers'

describe('normalizeIssueKeys', () => {
  test('dedupes, trims and upper-cases, keeping order', () => {
    expect(normalizeIssueKeys([' a-1', 'B-2', 'A-1'])).toEqual({ ok: true, keys: ['A-1', 'B-2'] })
  })
  test('rejects empty, non-array, bad keys and more than 500', () => {
    expect(normalizeIssueKeys([]).ok).toBe(false)
    expect(normalizeIssueKeys('A-1').ok).toBe(false)
    expect(normalizeIssueKeys(['A-1', 5]).ok).toBe(false)
    expect(normalizeIssueKeys(['a b']).ok).toBe(false)
    expect(normalizeIssueKeys(Array.from({ length: MAX_BULK_ISSUES + 1 }, (_, i) => `A-${i}`)).ok).toBe(false)
    expect(normalizeIssueKeys(Array.from({ length: MAX_BULK_ISSUES }, (_, i) => `A-${i}`)).ok).toBe(true)
  })
})

describe('parseBulkParams', () => {
  test('transition coerces the id and rejects unknown keys', () => {
    expect(parseBulkParams('transition', { transitionId: '4' })).toEqual({ ok: true, params: { transitionId: 4 } })
    expect(parseBulkParams('transition', { transitionId: 4, x: 1 }).ok).toBe(false)
    expect(parseBulkParams('transition', {}).ok).toBe(false)
  })
  test('assign allows null (unassign); priority needs an id', () => {
    expect(parseBulkParams('assign', { assigneeId: null }).ok).toBe(true)
    expect(parseBulkParams('assign', {}).ok).toBe(false)
    expect(parseBulkParams('priority', { priorityId: 0 }).ok).toBe(false)
  })
  test('label needs add, remove or set and no spaces', () => {
    expect(parseBulkParams('label', {}).ok).toBe(false)
    expect(parseBulkParams('label', { add: ['a b'] }).ok).toBe(false)
    expect(parseBulkParams('label', { add: ['x'], remove: ['y'] }).ok).toBe(true)
  })
  test('edit only accepts whitelisted fields', () => {
    expect(parseBulkParams('edit', { fields: { summary: 'x' } }).ok).toBe(false)
    expect(parseBulkParams('edit', { fields: {} }).ok).toBe(false)
    expect(parseBulkParams('edit', { fields: { duedate: '2026-01-02', priority: { id: 2 } } }).ok).toBe(true)
    expect(parseBulkParams('edit', { fields: { duedate: 'tomorrow' } }).ok).toBe(false)
  })
  test('sprint accepts null (backlog); delete and watch take no params', () => {
    expect(parseBulkParams('sprint', { sprintId: null }).ok).toBe(true)
    expect(parseBulkParams('delete', undefined).ok).toBe(true)
    expect(parseBulkParams('watch', { x: 1 }).ok).toBe(false)
  })
})

describe('applyListChange', () => {
  test('add keeps order and uniqueness, remove filters, set replaces', () => {
    expect(applyListChange(['a', 'b'], { add: ['b', 'c'] })).toEqual(['a', 'b', 'c'])
    expect(applyListChange(['a', 'b', 'c'], { remove: ['b'] })).toEqual(['a', 'c'])
    expect(applyListChange(['a', 'b'], { add: ['z'], remove: ['a'] })).toEqual(['b', 'z'])
    expect(applyListChange(['a'], { set: ['x', 'x', 'y'], add: ['q'] })).toEqual(['x', 'y'])
    expect(applyListChange([1, 2], { add: [3] })).toEqual([1, 2, 3])
  })
  test('sameList ignores order', () => {
    expect(sameList(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameList(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('groupUndo', () => {
  test('issues with identical previous values share one group', () => {
    const g = groupUndo('priority', [
      { key: 'A-1', params: { priorityId: 2 } }, { key: 'A-2', params: { priorityId: 3 } }, { key: 'A-3', params: { priorityId: 2 } },
    ])
    expect(g).toHaveLength(2)
    expect(g.find((x) => x.params.priorityId === 2)!.issueKeys).toEqual(['A-1', 'A-3'])
  })
  test('key order inside params does not matter', () => {
    const g = groupUndo('edit', [{ key: 'A-1', params: { a: 1, b: 2 } }, { key: 'A-2', params: { b: 2, a: 1 } }])
    expect(g).toHaveLength(1)
  })
})

describe('mergeTransitions', () => {
  const t = (id: number, name: string) => ({ id, name, to: { id: id * 10, name: `S${id}` } })
  test('counts per transition and finds the common ones', () => {
    const r = mergeTransitions([
      { key: 'A-1', transitions: [t(1, 'Start'), t(2, 'Close')] },
      { key: 'A-2', transitions: [t(1, 'Start')] },
    ])
    expect(r.total).toBe(2)
    expect(r.commonIds).toEqual([1])
    expect(r.transitions[0]).toMatchObject({ id: 1, count: 2 })
    expect(r.transitions[1]).toMatchObject({ id: 2, count: 1, issueKeys: ['A-1'] })
  })
  test('empty selection has no common transitions beyond vacuous truth', () => {
    expect(mergeTransitions([]).transitions).toEqual([])
  })
})

describe('failures', () => {
  test('groupFailures collapses identical reasons, largest first', () => {
    const g = groupFailures([{ key: 'A-1', reason: 'x' }, { key: 'A-2', reason: 'y' }, { key: 'A-3', reason: 'y' }])
    expect(g[0]).toEqual({ reason: 'y', count: 2, keys: ['A-2', 'A-3'] })
  })
  test('reasonFromBody prefers messages, falls back to status', () => {
    expect(reasonFromBody(400, { errorMessages: ['Nope'], validationErrors: ['Comment required'] })).toBe('Nope; Comment required')
    expect(reasonFromBody(400, { errors: { x: 'bad x' } })).toBe('bad x')
    expect(reasonFromBody(403, null)).toBe('Forbidden')
    expect(reasonFromBody(500, {})).toBe('Request failed (500)')
  })
})
