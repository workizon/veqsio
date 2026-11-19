import { describe, test, expect } from 'bun:test'
import { summarizeMembers, levelChoices, securityPayload, mappingBody, describeDelete, needsTarget, MEMBER_TYPES, MEMBER_TYPE_LABEL, type LevelMember } from '../lib/issue-security'

const m = (type: LevelMember['type'], label: string): LevelMember => ({ id: 1, type, userId: null, groupId: null, roleId: null, label })

describe('issue security helpers', () => {
  test('every member type has a label and only user/group/role need a picker', () => {
    for (const t of MEMBER_TYPES) expect(MEMBER_TYPE_LABEL[t]).toBeTruthy()
    expect(MEMBER_TYPES.filter(needsTarget)).toEqual(['user', 'group', 'role'])
  })
  test('summarizeMembers names the first members and counts the rest', () => {
    expect(summarizeMembers([])).toContain('Nobody')
    expect(summarizeMembers([m('user', 'Ann'), m('group', 'dev'), m('role', 'Lead')])).toBe('Ann, Group dev, Role Lead')
    expect(summarizeMembers([m('user', 'A'), m('user', 'B'), m('reporter', 'Reporter'), m('assignee', 'Assignee'), m('any_user', 'x')])).toBe('A, B, Reporter +2')
  })
  test('levelChoices puts None first and marks the default', () => {
    const c = levelChoices([{ id: 1, name: 'Secret' }, { id: 2, name: 'Staff', description: 'd' }], 2)
    expect(c.map((x) => [x.value, x.label])).toEqual([['', 'None'], ['1', 'Secret'], ['2', 'Staff (default)']])
    expect(levelChoices([{ id: 1, name: 'S' }], null, false).map((x) => x.value)).toEqual(['1'])
  })
  test('securityPayload only sends a change', () => {
    expect(securityPayload('', null)).toBeUndefined()
    expect(securityPayload('3', 3)).toBeUndefined()
    expect(securityPayload('', 3)).toBeNull()
    expect(securityPayload('4', 3)).toEqual({ id: 4 })
    expect(securityPayload('4', undefined)).toEqual({ id: 4 })
  })
  test('mappingBody requires a choice for every level in use ("" removes the level)', () => {
    const used = [{ levelId: 1, n: 2 }, { levelId: 2, n: 1 }]
    expect(mappingBody(used, { 1: '10' })).toEqual({ ok: false, levelMapping: { '1': 10 } })
    expect(mappingBody(used, { 1: '10', 2: '' })).toEqual({ ok: true, levelMapping: { '1': 10, '2': null } })
    expect(mappingBody([], {})).toEqual({ ok: true, levelMapping: {} })
  })
  test('describeDelete explains why a level in use cannot go', () => {
    expect(describeDelete({ name: 'Secret', issueCount: 0 })).toBeNull()
    expect(describeDelete({ name: 'Secret', issueCount: 1 })).toContain('1 issue use')
    expect(describeDelete({ name: 'Secret', issueCount: 3 })).toContain('3 issues use')
  })
})
