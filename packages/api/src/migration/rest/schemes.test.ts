import { describe, test, expect } from 'bun:test'
import { mapPermission, mapHolder, mapEvent, mapNotificationScheme } from './schemes'

describe('Jira permission mapping', () => {
  test('keys shared with Jira pass through, renamed ones are renamed, unknown ones are dropped', () => {
    expect(mapPermission('BROWSE_PROJECTS')).toBe('BROWSE_PROJECTS')
    expect(mapPermission('manage_sprints_permission')).toBe('MANAGE_SPRINTS')
    expect(mapPermission('VIEW_DEV_TOOLS')).toBeNull()
    expect(mapPermission('SOMETHING_NEW')).toBeNull()
  })
  test('Data Center: people by login, roles by id, the project lead as "lead"', () => {
    expect(mapHolder({ type: 'user', user: { name: 'jdoe', key: 'JIRAUSER10', displayName: 'J Doe' } })).toMatchObject({ target: { kind: 'user', accountId: 'jdoe' } })
    expect(mapHolder({ type: 'user', parameter: 'jdoe' })).toMatchObject({ target: { kind: 'user', accountId: 'jdoe' } })
    expect(mapHolder({ type: 'lead' })).toEqual({ target: { kind: 'lead' } })
    const names = new Map([['10002', 'Developers']])
    expect(mapHolder({ type: 'projectRole', parameter: '10002' }, names)).toEqual({ target: { kind: 'role', name: 'Developers' } })
    expect(mapHolder({ type: 'projectRole', parameter: '99999' }, names)).toEqual({ skip: 'a project role without a name' })
    expect(mapHolder({ type: 'group', parameter: 'jira-users' })).toEqual({ target: { kind: 'group', name: 'jira-users' } })
  })
  test('holders', () => {
    expect(mapHolder({ type: 'group', group: { name: 'jira-developers' } })).toEqual({ target: { kind: 'group', name: 'jira-developers' } })
    expect(mapHolder({ type: 'projectRole', projectRole: { name: 'Developers' } })).toEqual({ target: { kind: 'role', name: 'Developers' } })
    expect(mapHolder({ type: 'projectLead' })).toEqual({ target: { kind: 'lead' } })
    expect(mapHolder({ type: 'applicationRole' })).toEqual({ target: { kind: 'loggedIn' } })
    expect(mapHolder({ type: 'anyone' })).toEqual({ target: { kind: 'anyone' } })
    expect(mapHolder({ type: 'reporter' })).toEqual({ skip: 'holder type "reporter"' })
    expect(mapHolder({ type: 'group' })).toEqual({ skip: 'a group without a name' })
  })
})

describe('Jira notification mapping', () => {
  test('events', () => {
    expect(mapEvent('Issue Created')).toBe('issue.created')
    expect(mapEvent('Issue Commented')).toBe('comment.added')
    expect(mapEvent('Issue Resolved')).toBe('issue.transitioned')
    expect(mapEvent('Issue Assigned')).toBe('issue.updated')
    expect(mapEvent('Something Custom')).toBeNull()
  })
  test('several Jira events fold into one row and unsupported recipients are reported', () => {
    const w: string[] = []
    const rows = mapNotificationScheme([
      { event: { name: 'Issue Updated' }, notifications: [{ notificationType: 'CurrentAssignee' }, { notificationType: 'Group' }] },
      { event: { name: 'Issue Assigned' }, notifications: [{ notificationType: 'Reporter' }] },
      { event: { name: 'Issue Created' }, notifications: [{ notificationType: 'AllWatchers' }, { notificationType: 'ProjectLead' }] },
      { event: { name: 'Custom Event' }, notifications: [{ notificationType: 'Reporter' }] },
      { event: { name: 'Issue Deleted' }, notifications: [] },
    ], w, 'Default')
    const upd = rows.find((r) => r.eventType === 'issue.updated')!
    expect(upd.notifyAssignee).toBe(true)
    expect(upd.notifyReporter).toBe(true)
    expect(upd.notifyWatchers).toBe(false)
    const cr = rows.find((r) => r.eventType === 'issue.created')!
    expect(cr.notifyWatchers && cr.notifyProjectLead).toBe(true)
    expect(w.some((x) => x.includes('Group'))).toBe(true)
    expect(w.some((x) => x.includes('Custom Event'))).toBe(true)
  })
})
