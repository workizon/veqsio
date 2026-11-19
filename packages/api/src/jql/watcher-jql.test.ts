import { describe, expect, it } from 'bun:test'
import { parseJQL } from './index'

describe('watcher / voter fields', () => {
  const ctx = { currentUserId: 3, userNames: { anna: 5 } } as any
  for (const q of ['watcher = currentUser()', 'watcher in (anna, 5)', 'watcher is EMPTY', 'watcher != currentUser()', 'voter = currentUser()', 'watcher = currentUser() AND project = X ORDER BY created DESC']) {
    it(`translates: ${q}`, () => {
      expect(() => parseJQL(q, ctx)).not.toThrow()
    })
  }
  it('still rejects unknown fields', () => {
    expect(() => parseJQL('wachter = currentUser()', ctx)).toThrow()
  })
})
