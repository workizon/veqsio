import { describe, test, expect } from 'bun:test'
import {
  initialScreenValues, validateScreenValues, buildScreenPayload, splitServerErrors, generalScreenFields, screenRequires, screenHasField,
  parseStoryPoints, type ScreenField,
} from '../lib/transition-screen'
import { extraRequiredFields } from '../lib/issue-view'

const f = (key: string, type: ScreenField['type'], extra: Partial<ScreenField> = {}): ScreenField => ({ key, name: key[0].toUpperCase() + key.slice(1), type, custom: key.startsWith('customfield_'), required: false, ...extra })
const FIELDS: ScreenField[] = [
  f('resolution', 'resolution', { required: true }), f('assignee', 'user', { required: true }), f('priority', 'priority'), f('labels', 'labels'),
  f('fixVersions', 'versions'), f('components', 'components'), f('duedate', 'date'), f('storyPoints', 'number'), f('environment', 'text'), f('comment', 'comment'),
  f('customfield_5', 'number', { name: 'Effort' }), f('customfield_6', 'select', { name: 'Team', options: ['Red', 'Blue'] }), f('customfield_7', 'boolean', { name: 'Flag' }),
]

describe('screen field selection', () => {
  test('resolution and comment keep their dedicated inputs, the rest is rendered from the screen', () => {
    expect(generalScreenFields({ screenFields: FIELDS }).map((x) => x.key)).not.toContain('resolution')
    expect(generalScreenFields({ screenFields: FIELDS }).map((x) => x.key)).not.toContain('comment')
    expect(generalScreenFields({})).toEqual([])
    expect(screenRequires({ screenFields: FIELDS }, 'resolution')).toBe(true)
    expect(screenRequires({ screenFields: FIELDS }, 'priority')).toBe(false)
    expect(screenHasField({ screenFields: FIELDS }, 'comment')).toBe(true)
  })
  test('screen fields are not treated as generic "extra required" text inputs', () => {
    const t = { id: 1, name: 'x', to: { id: 1, name: 'y' }, fields: { assignee: { required: true }, mustHave: { required: true } }, requiredFields: ['mustHave'], screenFields: FIELDS }
    expect(extraRequiredFields(t as any)).toEqual(['mustHave'])
  })
})

describe('initialScreenValues', () => {
  test('pre-fills from the issue, including custom fields', () => {
    const v = initialScreenValues(FIELDS, {
      assignee: { id: 3, displayName: 'Ann' }, priority: { id: 2, name: 'High', color: '#f00' }, labels: ['a'], fixVersions: [{ id: 1, name: '1.0' }], components: [], duedate: '2026-01-02',
      storyPoints: 3, environment: 'prod', customfield_5: 8, customfield_6: 'Red', customfield_7: true,
    })
    expect(v).toEqual({
      assignee: { id: 3, displayName: 'Ann' }, priority: { id: 2, name: 'High', color: '#f00' }, labels: ['a'], fixVersions: [{ id: 1, name: '1.0' }], components: [], duedate: '2026-01-02',
      storyPoints: '3', environment: 'prod', customfield_5: '8', customfield_6: 'Red', customfield_7: 'true',
    })
  })
  test('empty issue gives empty values', () => {
    const v = initialScreenValues(FIELDS, undefined)
    expect(v.assignee).toBeNull()
    expect(v.priority).toBeNull()
    expect(v.labels).toEqual([])
    expect(v.storyPoints).toBe('')
    expect(v.customfield_5).toBe('')
  })
})

describe('validateScreenValues', () => {
  test('required fields, including the dedicated resolution and comment', () => {
    const fields = [f('resolution', 'resolution', { required: true }), f('comment', 'comment', { required: true }), f('assignee', 'user', { required: true }), f('labels', 'labels', { required: true })]
    expect(validateScreenValues(fields, { assignee: null, labels: [] }, { resolutionId: '', comment: ' ' })).toEqual({
      resolution: 'Resolution is required', comment: 'Comment is required', assignee: 'Assignee is required', labels: 'Labels is required',
    })
    expect(validateScreenValues(fields, { assignee: { id: 1, displayName: 'A' }, labels: ['x'] }, { resolutionId: '3', comment: 'ok' })).toEqual({})
  })
  test('format checks', () => {
    const errs = validateScreenValues(FIELDS.filter((x) => !x.required), {
      duedate: '31/12/2026', storyPoints: '1001', labels: ['a b'], customfield_5: 'abc', customfield_6: 'Green',
    })
    expect(Object.keys(errs).sort()).toEqual(['customfield_5', 'customfield_6', 'duedate', 'labels', 'storyPoints'])
  })
  test('optional empty fields are fine', () => {
    expect(validateScreenValues(FIELDS.filter((x) => !x.required), { duedate: '', storyPoints: '', labels: [] })).toEqual({})
  })
  test('parseStoryPoints mirrors the server', () => {
    expect(parseStoryPoints('')).toBeNull()
    expect(parseStoryPoints('3,5')).toBe(3.5)
    expect(parseStoryPoints('1.234')).toBeUndefined()
    expect(parseStoryPoints('-1')).toBeUndefined()
  })
})

describe('buildScreenPayload', () => {
  test('Jira shapes, clearing and custom types', () => {
    const p = buildScreenPayload(FIELDS, {
      assignee: { id: 3, displayName: 'Ann' }, priority: { id: 2, name: 'High' }, labels: ['a'], fixVersions: [{ id: 1, name: '1.0' }], components: [], duedate: '', storyPoints: '2,5', environment: 'x',
      customfield_5: '7', customfield_6: 'Blue', customfield_7: 'true',
    })
    expect(p).toEqual({
      assignee: { id: 3 }, priority: { id: 2 }, labels: ['a'], fixVersions: [{ id: 1 }], components: [], duedate: null, storyPoints: 2.5, environment: 'x',
      customfield_5: 7, customfield_6: 'Blue', customfield_7: true,
    })
    expect(buildScreenPayload([f('assignee', 'user'), f('priority', 'priority'), f('customfield_5', 'number')], { assignee: null, priority: null, customfield_5: '' }))
      .toEqual({ assignee: null, priority: null, customfield_5: null })
  })
  test('resolution and comment are not part of it (they use the dedicated inputs)', () => {
    expect(buildScreenPayload([f('resolution', 'resolution'), f('comment', 'comment')], {})).toEqual({})
  })
})

describe('splitServerErrors', () => {
  test('field errors go inline, the rest stays in the general list without duplicates', () => {
    const r = splitServerErrors(FIELDS, { assignee: 'Assignee is required', unknown: 'x' }, ['Assignee is required', 'Other problem'])
    expect(r.byField).toEqual({ assignee: 'Assignee is required' })
    expect(r.general).toEqual(['Other problem'])
  })
  test('no field errors: everything stays general', () => {
    expect(splitServerErrors(FIELDS, undefined, ['a'])).toEqual({ byField: {}, general: ['a'] })
  })
})
