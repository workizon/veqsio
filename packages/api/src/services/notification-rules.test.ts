import { describe, test, expect } from 'bun:test'

process.env.DATABASE_URL ||= 'postgresql://postgres@localhost:5460/unused'
const { ISSUE_EVENT_RULES, recipientOptionsFor } = await import('./notifications')

describe('notification recipient rules', () => {
  test('every issue event has rules and a label', () => {
    for (const [id, def] of Object.entries(ISSUE_EVENT_RULES)) {
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.rules.length).toBeGreaterThan(0)
      expect(id).toMatch(/^(issue|comment)\./)
    }
  })

  test('creation notifies everybody with a stake and never excludes the creator', () => {
    expect(recipientOptionsFor('issue.created', 7)).toEqual({
      includeAssignee: true, includeReporter: true, includeWatchers: true, includeProjectLead: true, excludeUserId: undefined,
    })
  })

  test('updates, transitions and comments exclude the acting user', () => {
    for (const e of ['issue.updated', 'issue.transitioned', 'comment.added'] as const) {
      expect(recipientOptionsFor(e, 7).excludeUserId).toBe(7)
      expect(recipientOptionsFor(e).excludeUserId).toBeUndefined()
    }
  })

  test('an assignment goes to the assignee only, even when they assigned themselves', () => {
    expect(recipientOptionsFor('issue.assigned', 7)).toEqual({
      includeAssignee: true, includeReporter: false, includeWatchers: false, includeProjectLead: false, excludeUserId: undefined,
    })
  })
})
