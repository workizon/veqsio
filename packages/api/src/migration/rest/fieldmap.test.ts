import { describe, expect, test } from 'bun:test'
import { compatibleTypes, planFields, skipReason } from './fieldmap'
import { contextsFromCreateMeta, parseAllowed, parseOptions } from './fieldmeta'
import { contextPairs, optionLabels } from './fieldsync'
import type { JiraFieldMeta } from './customfields'

const f = (id: string, name: string, type = 'string', custom?: string): JiraFieldMeta => ({ id, name, custom: true, schema: { type, ...(custom ? { custom } : {}) } })

describe('planFields', () => {
  test('a new field is created under its own name', () => {
    const [r] = planFields([f('customfield_10001', 'Customer impact', 'option')], [], new Map())
    expect(r).toMatchObject({ action: 'create', localName: 'Customer impact', ourType: 'select' })
  })
  test('the remembered Jira id wins over the name', () => {
    const existing = [{ id: 7, name: 'Renamed here', fieldType: 'select' }, { id: 8, name: 'Customer impact', fieldType: 'select' }]
    const [r] = planFields([f('customfield_10001', 'Customer impact', 'option')], existing, new Map([['customfield_10001', 7]]))
    expect(r).toMatchObject({ action: 'match-id', localId: 7, localName: 'Renamed here' })
  })
  test('without a remembered id, a field of the same name and a compatible type is used', () => {
    const [r] = planFields([f('customfield_10001', 'customer IMPACT', 'option')], [{ id: 8, name: 'Customer impact', fieldType: 'multiselect' }], new Map())
    expect(r).toMatchObject({ action: 'match-name', localId: 8 })
  })
  test('the same name with another type is not written into: a new field with a suffix, and the reason', () => {
    const [r] = planFields([f('customfield_10002', 'Budget', 'number')], [{ id: 9, name: 'Budget', fieldType: 'string' }], new Map())
    expect(r.action).toBe('create')
    expect(r.localName).toBe('Budget (customfield_10002)')
    expect(r.reason).toContain('another type')
  })
  test('two Jira fields with one name: the first takes the name, the second gets a suffix', () => {
    const rows = planFields([f('customfield_1', 'Team', 'option'), f('customfield_2', 'Team', 'option')], [], new Map())
    expect(rows.map((r) => r.localName)).toEqual(['Team', 'Team (customfield_2)'])
  })
  test('one existing field is not claimed by two Jira fields', () => {
    const rows = planFields([f('customfield_1', 'Team', 'option'), f('customfield_2', 'Team', 'option')], [{ id: 3, name: 'Team', fieldType: 'select' }], new Map())
    expect(rows[0]).toMatchObject({ action: 'match-name', localId: 3 })
    expect(rows[1].action).toBe('create')
  })
  test('a name match never takes the field that belongs to another Jira id', () => {
    const rows = planFields([f('customfield_1', 'Team', 'option'), f('customfield_2', 'Squad', 'option')], [{ id: 3, name: 'Team', fieldType: 'select' }], new Map([['customfield_2', 3]]))
    expect(rows.find((r) => r.jiraId === 'customfield_2')).toMatchObject({ action: 'match-id', localId: 3 })
    expect(rows.find((r) => r.jiraId === 'customfield_1')?.action).toBe('create')
  })
  test('overrides: skip, map to a chosen field, force a new one', () => {
    const existing = [{ id: 3, name: 'Team', fieldType: 'select' }, { id: 4, name: 'Other', fieldType: 'string' }]
    const jira = [f('customfield_1', 'Team', 'option'), f('customfield_2', 'Notes'), f('customfield_3', 'Extra')]
    const rows = planFields(jira, existing, new Map(), { customfield_1: { action: 'create' }, customfield_2: { action: 'map', localId: 4 }, customfield_3: { action: 'skip' } })
    expect(rows[0]).toMatchObject({ action: 'create', overridden: true, localName: 'Team (customfield_1)' })
    expect(rows[1]).toMatchObject({ action: 'match-id', localId: 4, overridden: true })
    expect(rows[2]).toMatchObject({ action: 'skip', overridden: true })
  })
  test('unsupported and internal fields are skipped with a reason', () => {
    const rows = planFields([f('customfield_5', 'Rank', 'any', 'com.pyxis.greenhopper.jira:gh-lexo-rank'), f('customfield_6', 'Assets', 'array')], [], new Map())
    expect(rows.map((r) => r.action)).toEqual(['skip', 'skip'])
    expect(rows[0].reason).toContain('internal')
    expect(skipReason(f('customfield_6', 'Assets', 'array'))).toContain('no counterpart')
  })
  test('compatible types', () => {
    expect(compatibleTypes('select', 'multiselect')).toBe(true)
    expect(compatibleTypes('string', 'number')).toBe(false)
  })
})

describe('field options and contexts', () => {
  test('cascading options become "Parent / Child" with the parent first', () => {
    const raw = [{ id: '1', value: 'Europe' }, { id: '2', value: 'Asia' }, { id: '3', value: 'Berlin', optionId: '1' }, { id: '4', value: 'Old', disabled: true }]
    expect(optionLabels(parseOptions(raw))).toEqual([
      { value: 'Europe', archived: false }, { value: 'Europe / Berlin', archived: false }, { value: 'Asia', archived: false }, { value: 'Old', archived: true },
    ])
  })
  test('create metadata: allowed values with children', () => {
    expect(parseAllowed([{ id: '1', value: 'A', children: [{ id: '2', value: 'B' }] }, { name: 'C' }])).toEqual([{ value: 'A' }, { value: 'B', parent: 'A' }, { value: 'C' }])
  })
  test('create metadata: present for every type of every project is one global context', () => {
    const projects = [
      { key: 'A', issuetypes: [{ name: 'Bug', fields: { cf: { allowedValues: [{ value: 'x' }] } } }, { name: 'Task', fields: { cf: { allowedValues: [{ value: 'x' }, { value: 'y' }] } } }] },
      { key: 'B', issuetypes: [{ name: 'Bug', fields: { cf: { allowedValues: [{ value: 'z' }] } } }] },
    ]
    const r = contextsFromCreateMeta('cf', projects)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ global: true })
    expect(r[0].options.map((o) => o.value)).toEqual(['x', 'y', 'z'])
  })
  test('create metadata: limited to a project, and to one issue type in another', () => {
    const projects = [
      { key: 'A', issuetypes: [{ name: 'Bug', fields: { cf: {} } }, { name: 'Task', fields: { cf: {} } }] },
      { key: 'B', issuetypes: [{ name: 'Bug', fields: { cf: {} } }, { name: 'Task', fields: {} }] },
      { key: 'C', issuetypes: [{ name: 'Bug', fields: {} }] },
    ]
    const r = contextsFromCreateMeta('cf', projects)
    expect(r.map((c) => [c.projectKeys.join(), c.issueTypeNames?.join() ?? null])).toEqual([['A', null], ['B', 'Bug']])
  })
  test('context rows: global, project x type, and "not here"', () => {
    const pk = new Map([['A', 1], ['B', 2]]); const tn = new Map([['bug', 10], ['task', 11]])
    expect(contextPairs({ global: true, projectKeys: [], issueTypeNames: null, options: [] }, pk, tn)).toEqual([[null, null]])
    expect(contextPairs({ global: false, projectKeys: ['A', 'B'], issueTypeNames: ['Bug'], options: [] }, pk, tn)).toEqual([[1, 10], [2, 10]])
    expect(contextPairs({ global: false, projectKeys: ['A'], issueTypeNames: null, options: [] }, pk, tn)).toEqual([[1, null]])
    expect(contextPairs({ global: false, projectKeys: ['ZZ'], issueTypeNames: null, options: [] }, pk, tn)).toBe('unresolvable')
  })
})
