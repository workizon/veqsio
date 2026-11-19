import { describe, expect, test } from 'bun:test'
import { applyFieldRules, defaultFor, isEmptyValue, type FieldRuleFacts } from './field-rules'

const facts = (over: Partial<FieldRuleFacts> = {}): FieldRuleFacts => ({
  requiredIds: [],
  fields: [{ id: 1, name: 'Impact', defaultValue: null }, { id: 2, name: 'Region', defaultValue: 'EU' }],
  contexts: [],
  ...over,
})

describe('empty values', () => {
  test('what counts as empty', () => {
    expect([null, undefined, '', '  ', []].every(isEmptyValue)).toBe(true)
    expect([0, false, 'x', ['a']].some(isEmptyValue)).toBe(false)
  })
})

describe('defaults', () => {
  test('the most specific context wins, then the field default', () => {
    const f = facts({ contexts: [
      { customFieldId: 1, projectId: null, issueTypeId: null, defaultValue: 'Low' },
      { customFieldId: 1, projectId: 5, issueTypeId: null, defaultValue: 'Medium' },
      { customFieldId: 1, projectId: 5, issueTypeId: 9, defaultValue: 'High' },
    ] })
    expect(defaultFor(1, 5, 9, f)).toBe('High')
    expect(defaultFor(1, 5, 8, f)).toBe('Medium')
    expect(defaultFor(1, 6, 8, f)).toBe('Low')
    expect(defaultFor(2, 6, 8, f)).toBe('EU')
    expect(defaultFor(3, 6, 8, f)).toBeNull()
  })
})

describe('applying the rules to a new issue', () => {
  test('a context default fills a field the caller left out; the field own default alone does not', () => {
    const f = facts({ contexts: [{ customFieldId: 1, projectId: null, issueTypeId: null, defaultValue: 'Low' }] })
    const r = applyFieldRules([], 5, 9, f)
    expect(r.values).toEqual([{ fieldId: 1, value: 'Low' }])
    expect(r.missing).toEqual([])
  })
  test('a value the caller sent is kept', () => {
    const f = facts({ contexts: [{ customFieldId: 1, projectId: null, issueTypeId: null, defaultValue: 'Low' }] })
    expect(applyFieldRules([{ fieldId: 1, value: 'High' }], 5, 9, f).values).toEqual([{ fieldId: 1, value: 'High' }])
  })
  test('an empty required field is reported by name', () => {
    const r = applyFieldRules([{ fieldId: 1, value: '' }], 5, 9, facts({ requiredIds: [1] }))
    expect(r.missing).toEqual(['Impact'])
  })
  test('a required field with a default is filled, not reported', () => {
    const r = applyFieldRules(undefined, 5, 9, facts({ requiredIds: [2] }))
    expect(r.missing).toEqual([])
    expect(r.values).toEqual([{ fieldId: 2, value: 'EU' }])
  })
  test('nothing required, nothing sent: nothing to do', () => {
    const r = applyFieldRules(undefined, 5, 9, facts())
    expect(r).toEqual({ values: [], missing: [] })
  })
})
