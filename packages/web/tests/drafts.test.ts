import { describe, test, expect } from 'bun:test'
import {
  DRAFT_PREFIX, DRAFT_TTL_MS, issueDraftKey, quickCreateDraftKey, commentDraftKey, sanitizeDraft, isDraftEmpty, createDraftSession, descriptionDraftKey, DRAFT_DEBOUNCE_MS,
  saveDraft, loadDraft, clearDraft, purgeExpiredDrafts, createDebouncer, describeDraftAge, type StorageLike,
} from '../lib/drafts'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() { return data.size },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) },
  }
}

const throwing: StorageLike = {
  length: 0,
  key: () => { throw new Error('blocked') },
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('quota') },
  removeItem: () => { throw new Error('blocked') },
}

describe('keys', () => {
  test('include the user id so drafts do not leak between users', () => {
    expect(issueDraftKey(1, 2, 3)).not.toBe(issueDraftKey(9, 2, 3))
    expect(commentDraftKey(1, 'VEQ-1')).not.toBe(commentDraftKey(2, 'VEQ-1'))
    expect(quickCreateDraftKey(1, 2, 3)).not.toBe(issueDraftKey(1, 2, 3))
  })
  test('are scoped by project+type and by issue + reply target', () => {
    expect(issueDraftKey(1, 2, 3)).not.toBe(issueDraftKey(1, 2, 4))
    expect(issueDraftKey(1, 2, 3)).not.toBe(issueDraftKey(1, 5, 3))
    expect(commentDraftKey(1, 'VEQ-1')).toBe(commentDraftKey(1, 'VEQ-1', null))
    expect(commentDraftKey(1, 'VEQ-1')).not.toBe(commentDraftKey(1, 'VEQ-1', 7))
    expect(commentDraftKey(1, 'VEQ-1', 7)).not.toBe(commentDraftKey(1, 'VEQ-2', 7))
  })
  test('all start with the shared prefix and cannot be confused by separators in values', () => {
    expect(commentDraftKey(1, 'A:B', 'x').startsWith(DRAFT_PREFIX)).toBe(true)
    expect(commentDraftKey('1:2', 'K')).not.toBe(commentDraftKey('1', '2:K'))
  })
})

describe('sanitizeDraft', () => {
  test('drops attachments, files, tokens and secrets but keeps normal fields', () => {
    const out = sanitizeDraft({
      summary: 'Hi', description: 'Body', labels: ['a'], attachments: [{ name: 'x.png' }], files: [1],
      password: 'p', apiToken: 't', nested: { secretKey: 's', ok: 1 }, fn: () => 1, gone: undefined,
    } as Record<string, unknown>)
    expect(out).toEqual({ summary: 'Hi', description: 'Body', labels: ['a'], nested: { ok: 1 } } as never)
  })
  test('drops Blob values', () => {
    const out = sanitizeDraft({ text: 'a', thing: new Blob(['x']) } as Record<string, unknown>)
    expect(out).toEqual({ text: 'a' } as never)
  })
})

describe('isDraftEmpty', () => {
  test('blank strings, empty arrays and false flags are empty', () => {
    expect(isDraftEmpty({ summary: '  ', labels: [], internal: false })).toBe(true)
    expect(isDraftEmpty({ summary: 'x' })).toBe(false)
    expect(isDraftEmpty({ labels: ['a'] })).toBe(false)
    expect(isDraftEmpty({ internal: true })).toBe(false)
  })
  test('ignored keys do not count (for example a default priority)', () => {
    expect(isDraftEmpty({ summary: '', priorityId: '3' }, ['priorityId'])).toBe(true)
  })
})

describe('save / load / clear', () => {
  test('round trips and reports the save time', () => {
    const s = memoryStorage()
    expect(saveDraft(s, 'k', { text: 'hello' }, 1000)).toBe(true)
    expect(loadDraft(s, 'k', 2000)).toEqual({ data: { text: 'hello' }, savedAt: 1000 })
    clearDraft(s, 'k')
    expect(loadDraft(s, 'k')).toBeNull()
  })
  test('never stores sanitised-away fields', () => {
    const s = memoryStorage()
    saveDraft(s, 'k', { text: 'a', attachments: ['secret.png'], password: 'x' })
    const raw = s.getItem('k')!
    expect(raw).not.toContain('secret.png')
    expect(raw).not.toContain('password')
  })
  test('expires after 14 days and removes the entry', () => {
    const s = memoryStorage()
    saveDraft(s, 'k', { text: 'old' }, 0)
    expect(loadDraft(s, 'k', DRAFT_TTL_MS)).not.toBeNull()
    expect(loadDraft(s, 'k', DRAFT_TTL_MS + 1)).toBeNull()
    expect(s.getItem('k')).toBeNull()
  })
  test('malformed or foreign JSON is treated as missing and removed', () => {
    const s = memoryStorage({ a: 'not json', b: '{"v":2,"savedAt":1,"data":{}}', c: '{"v":1}' })
    expect(loadDraft(s, 'a')).toBeNull()
    expect(loadDraft(s, 'b')).toBeNull()
    expect(loadDraft(s, 'c')).toBeNull()
    expect(s.data.size).toBe(0)
  })
  test('survives unavailable storage', () => {
    expect(saveDraft(null, 'k', { a: 1 })).toBe(false)
    expect(loadDraft(null, 'k')).toBeNull()
    expect(saveDraft(throwing, 'k', { a: 1 })).toBe(false)
    expect(loadDraft(throwing, 'k')).toBeNull()
    expect(() => clearDraft(throwing, 'k')).not.toThrow()
    expect(purgeExpiredDrafts(throwing)).toBe(0)
  })
})

describe('purgeExpiredDrafts', () => {
  test('removes only expired veqsio drafts', () => {
    const s = memoryStorage({ other: 'keep' })
    saveDraft(s, `${DRAFT_PREFIX}old`, { t: 1 }, 0)
    saveDraft(s, `${DRAFT_PREFIX}new`, { t: 2 }, DRAFT_TTL_MS)
    expect(purgeExpiredDrafts(s, DRAFT_TTL_MS + 10)).toBe(1)
    expect(s.getItem(`${DRAFT_PREFIX}old`)).toBeNull()
    expect(s.getItem(`${DRAFT_PREFIX}new`)).not.toBeNull()
    expect(s.getItem('other')).toBe('keep')
  })
})

function fakeTimers() {
  let t = 0
  let h = 1
  const q = new Map<number, { at: number; f: () => void }>()
  return {
    timers: { set: (f: () => void, ms: number) => { const id = h++; q.set(id, { at: t + ms, f }); return id }, clear: (id: unknown) => { q.delete(id as number) } },
    advance(ms: number) {
      t += ms
      for (const [id, e] of [...q]) if (e.at <= t) { q.delete(id); e.f() }
    },
  }
}

describe('createDebouncer', () => {
  test('only the last call within the window runs', () => {
    const f = fakeTimers()
    const seen: string[] = []
    const d = createDebouncer((v: string) => seen.push(v), 500, f.timers)
    d.call('a'); f.advance(300); d.call('b'); f.advance(300); d.call('c')
    expect(seen).toEqual([])
    f.advance(500)
    expect(seen).toEqual(['c'])
  })
  test('flush runs immediately, cancel drops', () => {
    const f = fakeTimers()
    const seen: string[] = []
    const d = createDebouncer((v: string) => seen.push(v), 500, f.timers)
    d.call('x'); d.flush()
    expect(seen).toEqual(['x'])
    d.call('y'); d.cancel(); f.advance(1000)
    expect(seen).toEqual(['x'])
    expect(d.pending).toBe(false)
  })
})

describe('describeDraftAge', () => {
  test('formats coarse ages', () => {
    expect(describeDraftAge(0, 20_000)).toBe('just now')
    expect(describeDraftAge(0, 5 * 60_000)).toBe('5 minutes ago')
    expect(describeDraftAge(0, 3 * 3600_000)).toBe('3 hours ago')
    expect(describeDraftAge(0, 2 * 86400_000)).toBe('2 days ago')
  })
})

describe('constants', () => {
  test('drafts expire after 14 days and save 500 ms after the last change', () => {
    expect(DRAFT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(DRAFT_DEBOUNCE_MS).toBe(500)
  })
  test('description keys are per user and issue', () => {
    expect(descriptionDraftKey(1, 'A-1')).not.toBe(descriptionDraftKey(2, 'A-1'))
    expect(descriptionDraftKey(1, 'A-1')).not.toBe(descriptionDraftKey(1, 'A-2'))
  })
})

describe('createDraftSession', () => {
  function setup(storage: StorageLike | null, isEmpty?: (d: { t: string }) => boolean) {
    const f = fakeTimers()
    let clock = 1000
    const session = createDraftSession<{ t: string }>({ storage, key: 'k', isEmpty, now: () => clock, timers: f.timers })
    return { f, session, setClock: (n: number) => { clock = n } }
  }
  test('saves after the debounce and restores the same data', () => {
    const s = memoryStorage()
    const { f, session } = setup(s)
    session.update({ t: 'hello' })
    expect(s.data.size).toBe(0)
    f.advance(DRAFT_DEBOUNCE_MS)
    expect(s.data.size).toBe(1)
    const again = setup(s).session.restore()
    expect(again?.data).toEqual({ t: 'hello' })
    expect(again?.savedAt).toBe(1000)
  })
  test('empty content removes the draft instead of storing it', () => {
    const s = memoryStorage()
    const { f, session } = setup(s)
    session.update({ t: 'x' }); f.advance(600)
    expect(s.data.size).toBe(1)
    session.update({ t: '   ' }); f.advance(600)
    expect(s.data.size).toBe(0)
  })
  test('clear after submit drops the draft and ignores pending saves until reopened', () => {
    const s = memoryStorage()
    const { f, session } = setup(s)
    session.update({ t: 'x' }); f.advance(600)
    session.update({ t: 'xy' })
    session.clear()
    f.advance(1000)
    expect(s.data.size).toBe(0)
    session.update({ t: 'later' }); f.advance(1000)
    expect(s.data.size).toBe(0)
    session.reopen()
    session.update({ t: 'later' }); f.advance(1000)
    expect(s.data.size).toBe(1)
  })
  test('flush saves a pending change at once (form unmounts)', () => {
    const s = memoryStorage()
    const { session } = setup(s)
    session.update({ t: 'abc' })
    expect(session.pending).toBe(true)
    session.flush()
    expect(s.data.size).toBe(1)
  })
  test('expired drafts are not restored and are removed', () => {
    const s = memoryStorage()
    const { f, session, setClock } = setup(s)
    session.update({ t: 'old' }); f.advance(600)
    setClock(1000 + DRAFT_TTL_MS + 1)
    expect(session.restore()).toBeNull()
    expect(s.data.size).toBe(0)
  })
  test('a stored draft whose content is empty is discarded on restore', () => {
    const s = memoryStorage()
    saveDraft(s, 'k', { t: '' }, 1000)
    expect(setup(s).session.restore()).toBeNull()
    expect(s.data.size).toBe(0)
  })
  test('storage unavailable: nothing throws, nothing is restored', () => {
    for (const storage of [throwing, null]) {
      const { f, session } = setup(storage)
      expect(() => { session.update({ t: 'x' }); f.advance(600); session.flush(); session.clear() }).not.toThrow()
      expect(setup(storage).session.restore()).toBeNull()
    }
  })
})
