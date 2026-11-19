import { describe, expect, test } from 'bun:test'
import { fetchCreateMeta, requiredFromCreateMeta } from './fieldmeta'
import { screenFieldTarget } from './screens'
import { parseRealWorkflow, inferWorkflow } from './workflows'
import { sniff, usableAvatarUrl } from './avatars'
import { requiredSetName } from './fieldsync'

describe('create metadata, old and new endpoints', () => {
  const classic: any = { get: async (p: string) => { if (p === '/rest/api/2/issue/createmeta') return { projects: [{ key: 'A', issuetypes: [{ name: 'Bug', fields: { customfield_1: { required: true }, customfield_2: { required: false } } }] }] }; throw new Error('x') } }
  const byType: any = { get: async (p: string) => {
    if (p === '/rest/api/2/issue/createmeta') throw new Error('Jira responded 404')
    if (p === '/rest/api/2/issue/createmeta/A/issuetypes') return { values: [{ id: '10', name: 'Bug' }, { id: '11', name: 'Task' }], isLast: true }
    if (p === '/rest/api/2/issue/createmeta/A/issuetypes/10') return { values: [{ fieldId: 'customfield_1', required: true, allowedValues: [{ value: 'x' }] }, { fieldId: 'summary', required: true }], isLast: true }
    if (p === '/rest/api/2/issue/createmeta/A/issuetypes/11') return { values: [{ fieldId: 'customfield_2', required: false }], isLast: true }
    throw new Error('unexpected ' + p)
  } }
  const cloudShape: any = { get: async (p: string) => {
    if (p === '/rest/api/2/issue/createmeta') return { projects: [] }
    if (p === '/rest/api/2/issue/createmeta/A/issuetypes') return { issueTypes: [{ id: '10', name: 'Bug' }], isLast: true, total: 1 }
    if (p === '/rest/api/2/issue/createmeta/A/issuetypes/10') return { fields: [{ fieldId: 'customfield_1', required: true }], isLast: true }
    throw new Error('unexpected ' + p)
  } }
  test('classic', async () => {
    const m = await fetchCreateMeta(classic, ['A'])
    expect(requiredFromCreateMeta(['customfield_1', 'customfield_2'], m).get('customfield_1')).toEqual([{ projectKey: 'A', issueTypeName: 'Bug' }])
    expect(requiredFromCreateMeta(['customfield_2'], m).size).toBe(0)
  })
  test('per project and issue type (Jira 10, with the list under values)', async () => {
    const m = await fetchCreateMeta(byType, ['A'])
    expect(m[0].issuetypes.map((t) => t.name)).toEqual(['Bug', 'Task'])
    expect(requiredFromCreateMeta(['customfield_1'], m).get('customfield_1')).toEqual([{ projectKey: 'A', issueTypeName: 'Bug' }])
  })
  test('per project and issue type (Cloud, with issueTypes and fields)', async () => {
    const m = await fetchCreateMeta(cloudShape, ['A'])
    expect(requiredFromCreateMeta(['customfield_1'], m).get('customfield_1')).toEqual([{ projectKey: 'A', issueTypeName: 'Bug' }])
  })
})

describe('screens', () => {
  test('which screen field becomes what', () => {
    const b = new Map([['customfield_10', 7]]); const sp = new Set(['customfield_99'])
    expect(screenFieldTarget('assignee', b, sp)).toEqual({ custom: false, key: 'assignee' })
    expect(screenFieldTarget('customfield_10', b, sp)).toEqual({ custom: true, fieldId: 7 })
    expect(screenFieldTarget('customfield_99', b, sp)).toEqual({ custom: false, key: 'storyPoints' })
    expect(screenFieldTarget('summary', b, sp)).toBeNull()
    expect(screenFieldTarget('customfield_404', b, sp)).toBeNull()
  })
  test('a transition keeps the screen Jira shows', () => {
    const w = parseRealWorkflow({
      name: 'W', statuses: [{ id: '1', name: 'Open' }, { id: '2', name: 'Done' }],
      transitions: [{ name: 'Create', type: 'initial', to: '1' }, { name: 'Finish', from: ['1'], to: '2', screen: { id: '55' } }],
    })!
    expect(w.transitions.find((t) => t.name === 'Finish')?.screen).toBe('55')
    const plan = inferWorkflow({ first: new Map(), current: new Map(), pairs: new Map(), subtask: false } as any, w)
    expect(plan.transitions.find((t) => t.name === 'Finish')?.screen).toBe('55')
  })
})

describe('avatars', () => {
  test('placeholder pictures are not worth copying', () => {
    expect(usableAvatarUrl({ '48x48': 'https://secure.gravatar.com/avatar/abc?d=https%3A%2F%2Favatar-management.example%2Finitials%2FAL-3.png' })).toBeNull()
    expect(usableAvatarUrl({ '48x48': 'https://jira.example.com/secure/useravatar?ownerId=ann&avatarId=12345' })).toBe('https://jira.example.com/secure/useravatar?ownerId=ann&avatarId=12345')
    expect(usableAvatarUrl({ '48x48': 'javascript:alert(1)' })).toBeNull()
    expect(usableAvatarUrl(undefined)).toBeNull()
  })
  test('the image type is taken from the bytes; SVG is never accepted', () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg')
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('')
  })
})

describe('field configuration names', () => {
  test('the set of required fields in the name', () => {
    expect(requiredSetName(['Budget', 'Impact'])).toBe('Jira: required Budget, Impact')
    expect(requiredSetName(['A', 'B', 'C', 'D', 'E'])).toBe('Jira: required A, B, C and 2 more')
  })
})
