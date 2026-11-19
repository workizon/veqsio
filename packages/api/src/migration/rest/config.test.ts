import { describe, expect, test } from 'bun:test'
import { schemeNameFor, statusCategory } from './config'
import { ADMIN_GROUP_NAMES, INTERNAL_GROUP, parseRoleActor, userKeys } from './people'

describe('configuration mapping', () => {
  test('status categories', () => {
    expect(statusCategory({ statusCategory: { key: 'new' } })).toBe('to_do')
    expect(statusCategory({ statusCategory: { key: 'indeterminate' } })).toBe('in_progress')
    expect(statusCategory({ statusCategory: { key: 'done' } })).toBe('done')
    expect(statusCategory({})).toBe('to_do')
  })
  test('one scheme name per set of issue types, whatever the order', () => {
    expect(schemeNameFor(['Task', 'Bug'])).toBe(schemeNameFor(['Bug', 'Task']))
    expect(schemeNameFor(['Task', 'Bug'])).toBe('Jira: Bug, Task')
    expect(schemeNameFor(Array.from({ length: 80 }, (_, i) => `Type number ${i}`)).length).toBeLessThanOrEqual(255)
  })
})

describe('people mapping', () => {
  test('role actors of Cloud and of Data Center', () => {
    expect(parseRoleActor({ type: 'atlassian-user-role-actor', actorUser: { accountId: 'abc' }, displayName: 'Ann' })).toEqual({ kind: 'user', ref: { accountId: 'abc', name: undefined, displayName: 'Ann' } })
    expect(parseRoleActor({ type: 'atlassian-user-role-actor', name: 'ann', displayName: 'Ann' })).toMatchObject({ kind: 'user', ref: { name: 'ann' } })
    expect(parseRoleActor({ type: 'atlassian-group-role-actor', actorGroup: { name: 'devs' } })).toEqual({ kind: 'group', name: 'devs' })
    expect(parseRoleActor({ type: 'atlassian-group-role-actor', name: 'jira-users' })).toEqual({ kind: 'group', name: 'jira-users' })
    expect(parseRoleActor({ type: 'something-else' })).toBeNull()
  })
  test('administrator and internal groups', () => {
    expect(ADMIN_GROUP_NAMES.test('jira-administrators')).toBe(true)
    expect(ADMIN_GROUP_NAMES.test('System-Administrators')).toBe(true)
    expect(ADMIN_GROUP_NAMES.test('developers')).toBe(false)
    expect(INTERNAL_GROUP.test('atlassian-addons-admin')).toBe(true)
  })
  test('the keys a user can be found by', () => {
    expect(userKeys({ accountId: 'a1', name: 'ann', key: 'JIRAUSER1' })).toEqual(['acct:a1', 'name:ann', 'key:JIRAUSER1'])
  })
})
