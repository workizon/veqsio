import { describe, expect, test } from 'bun:test'
import { keysToEvict, toOfflineRecord } from '../lib/offline-cache'

describe('offline reading', () => {
  test('only the text of the issue is kept, and it is bounded', () => {
    const r = toOfflineRecord({ key: 'WEB-1', fields: { summary: 'S', description: 'x'.repeat(30_000), status: { name: 'Open' }, assignee: { displayName: 'Ann', emailAddress: 'a@example.com' }, attachment: [{ content: 'https://x/y' }], project: { key: 'WEB', name: 'Web' } } }, 123)
    expect(r.description.length).toBe(20_000)
    expect(r.assignee).toBe('Ann')
    expect(r.status).toBe('Open')
    expect(r.project).toBe('Web')
    expect(JSON.stringify(r)).not.toContain('a@example.com')
    expect(JSON.stringify(r)).not.toContain('https://x/y')
    expect(r.savedAt).toBe(123)
  })
  test('missing fields become empty text', () => {
    const r = toOfflineRecord({ key: 'A-1', fields: {} })
    expect([r.summary, r.status, r.assignee, r.description]).toEqual(['', '', '', ''])
  })
  test('the oldest are dropped beyond the cap', () => {
    const recs = [{ key: 'a', savedAt: 3 }, { key: 'b', savedAt: 1 }, { key: 'c', savedAt: 2 }]
    expect(keysToEvict(recs, 2)).toEqual(['b'])
    expect(keysToEvict(recs, 3)).toEqual([])
    expect(keysToEvict(recs, 1)).toEqual(['b', 'c'])
  })
})
