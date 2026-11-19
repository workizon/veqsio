/**
 * "Previous / next in the list you came from": the issue list stores its result keys in sessionStorage and the
 * issue view steps through them. Everything is best effort; with no (or broken) data the feature stays hidden.
 */

export const ISSUE_LIST_STORAGE_KEY = 'veqsio-issue-list'

export interface StoredIssueList {
  keys: string[]
  /** What produced the list, for the "n of m" tooltip, e.g. the JQL. */
  label?: string
  savedAt: number
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const MAX_KEYS = 1000

export function saveIssueList(storage: StorageLike | null | undefined, keys: string[], label = '', now = Date.now()): boolean {
  if (!storage) return false
  try {
    const payload: StoredIssueList = { keys: keys.slice(0, MAX_KEYS), label, savedAt: now }
    storage.setItem(ISSUE_LIST_STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function loadIssueList(storage: StorageLike | null | undefined): StoredIssueList | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(ISSUE_LIST_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.keys)) return null
    const keys = data.keys.filter((k: unknown): k is string => typeof k === 'string' && k.length > 0)
    return { keys, label: typeof data.label === 'string' ? data.label : '', savedAt: Number(data.savedAt) || 0 }
  } catch {
    return null
  }
}

export interface Neighbours {
  /** 1-based position of the current issue. */
  position: number
  total: number
  prev: string | null
  next: string | null
}

/** Where `currentKey` sits in the stored list, or null when the list is absent or does not contain it. */
export function resolveNeighbours(list: StoredIssueList | null, currentKey: string): Neighbours | null {
  if (!list || list.keys.length === 0) return null
  const idx = list.keys.findIndex((k) => k.toLowerCase() === currentKey.toLowerCase())
  if (idx < 0) return null
  return {
    position: idx + 1,
    total: list.keys.length,
    prev: idx > 0 ? list.keys[idx - 1] : null,
    next: idx < list.keys.length - 1 ? list.keys[idx + 1] : null,
  }
}

/** The browser's sessionStorage, or null when unavailable (private mode, server render). */
export function browserSessionStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}
