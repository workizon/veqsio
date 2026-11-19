import { describe, test, expect } from 'bun:test'
import { compileQueueJql } from './queue-jql'

const ctx = { currentUserId: 5, statusNames: { open: 1 }, priorityNames: {}, issueTypeNames: {}, projectKeys: {}, projectNames: {}, userNames: {}, groupMembers: {}, openSprintIds: [], closedSprintIds: [] }

describe('compileQueueJql', () => {
  test('empty JQL matches everything', () => {
    const r = compileQueueJql('  ', ctx)
    expect(r).toMatchObject({ ok: true, where: undefined, orderBy: [] })
  })
  test('the three template queues compile', () => {
    for (const j of ['resolution = Unresolved', 'resolution = Unresolved AND assignee is EMPTY', 'resolution = Unresolved AND assignee = currentUser()']) {
      const r = compileQueueJql(j, ctx)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.where).toBeDefined()
    }
  })
  test('relative dates and ORDER BY', () => {
    const r = compileQueueJql('created >= -7d ORDER BY priority DESC, created ASC', ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.orderBy.length).toBe(2)
  })
  test('syntax error reports message and position', () => {
    const r = compileQueueJql('resolution = Unresolved AND AND', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.message.length).toBeGreaterThan(0); expect(typeof r.pos).toBe('number') }
  })
  test('unknown field is rejected', () => {
    const r = compileQueueJql('nosuchfield = 3', ctx)
    expect(r.ok).toBe(false)
  })
})
