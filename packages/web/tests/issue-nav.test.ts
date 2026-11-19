import { describe, test, expect } from 'bun:test'
import { ISSUE_LIST_STORAGE_KEY, loadIssueList, resolveNeighbours, saveIssueList, type StorageLike } from '../lib/issue-nav'

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v } }
}

const throwing: StorageLike = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('quota') },
}

describe('issue list storage', () => {
  test('round-trips keys and label', () => {
    const s = memory()
    expect(saveIssueList(s, ['A-1', 'A-2'], 'project = A', 5)).toBe(true)
    expect(loadIssueList(s)).toEqual({ keys: ['A-1', 'A-2'], label: 'project = A', savedAt: 5 })
  })

  test('survives missing, throwing and corrupt storage', () => {
    expect(loadIssueList(null)).toBeNull()
    expect(saveIssueList(undefined, ['A-1'])).toBe(false)
    expect(loadIssueList(throwing)).toBeNull()
    expect(saveIssueList(throwing, ['A-1'])).toBe(false)
    expect(loadIssueList(memory({ [ISSUE_LIST_STORAGE_KEY]: '{oops' }))).toBeNull()
    expect(loadIssueList(memory({ [ISSUE_LIST_STORAGE_KEY]: '{"keys":"nope"}' }))).toBeNull()
    expect(loadIssueList(memory())).toBeNull()
  })

  test('ignores non-string entries', () => {
    const s = memory({ [ISSUE_LIST_STORAGE_KEY]: JSON.stringify({ keys: ['A-1', 3, null, '', 'A-2'] }) })
    expect(loadIssueList(s)?.keys).toEqual(['A-1', 'A-2'])
  })

  test('caps the stored list', () => {
    const s = memory()
    saveIssueList(s, Array.from({ length: 5000 }, (_, i) => `A-${i}`))
    expect(loadIssueList(s)?.keys.length).toBe(1000)
  })
})

describe('resolveNeighbours', () => {
  const list = { keys: ['A-1', 'A-2', 'A-3'], savedAt: 0 }

  test('middle, first and last positions', () => {
    expect(resolveNeighbours(list, 'A-2')).toEqual({ position: 2, total: 3, prev: 'A-1', next: 'A-3' })
    expect(resolveNeighbours(list, 'A-1')).toEqual({ position: 1, total: 3, prev: null, next: 'A-2' })
    expect(resolveNeighbours(list, 'A-3')).toEqual({ position: 3, total: 3, prev: 'A-2', next: null })
  })

  test('is case-insensitive', () => {
    expect(resolveNeighbours(list, 'a-2')?.position).toBe(2)
  })

  test('falls back to null when there is no list or the issue is not in it', () => {
    expect(resolveNeighbours(null, 'A-1')).toBeNull()
    expect(resolveNeighbours({ keys: [], savedAt: 0 }, 'A-1')).toBeNull()
    expect(resolveNeighbours(list, 'B-9')).toBeNull()
  })

  test('a single-issue list has no neighbours but still resolves', () => {
    expect(resolveNeighbours({ keys: ['A-1'], savedAt: 0 }, 'A-1')).toEqual({ position: 1, total: 1, prev: null, next: null })
  })
})
