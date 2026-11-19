/**
 * Autosaved drafts in localStorage. Pure helpers: every function takes the storage (so tests can pass a fake)
 * and a clock, and swallows storage errors because storage may be unavailable (private windows, blocked site
 * data, quota). Nothing here touches React.
 *
 * Rules:
 *  - keys include the user id, so drafts never leak between users who share a browser;
 *  - drafts expire after 14 days;
 *  - attachments, files and secrets are never stored (`sanitizeDraft`).
 */

export const DRAFT_PREFIX = 'veqsio:draft:v1:'
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const DRAFT_DEBOUNCE_MS = 500

export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface Envelope<T> {
  v: 1
  savedAt: number
  data: T
}

/** The browser's localStorage, or null when it is missing or throws on access. */
export function getSafeStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    const s = window.localStorage
    // Touching the object can throw (SecurityError); a write probe catches quota-less/blocked storage.
    const probe = `${DRAFT_PREFIX}__probe`
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

const part = (v: string | number) => encodeURIComponent(String(v))

/** Draft for the create-issue page: one per user, project and issue type. */
export function issueDraftKey(userId: number | string, projectId: string | number, issueTypeId: string | number): string {
  return `${DRAFT_PREFIX}issue:${part(userId)}:${part(projectId)}:${part(issueTypeId)}`
}

/** Draft for the quick-create dialog (kept apart from the full form because it has fewer fields). */
export function quickCreateDraftKey(userId: number | string, projectId: string | number, issueTypeId: string | number): string {
  return `${DRAFT_PREFIX}quick:${part(userId)}:${part(projectId)}:${part(issueTypeId)}`
}

/** Draft for a comment box: one per user, issue and reply target (`root` for a new top-level comment). */
export function commentDraftKey(userId: number | string, issueKey: string, replyTargetId?: string | number | null): string {
  return `${DRAFT_PREFIX}comment:${part(userId)}:${part(issueKey)}:${replyTargetId == null || replyTargetId === '' ? 'root' : part(replyTargetId)}`
}

const FORBIDDEN_KEY = /attach|password|passwd|secret|token|apikey|api_key|credential|file|upload|blob/i

/**
 * Drops anything that must not be persisted: attachment-ish or secret-ish field names, File/Blob values,
 * functions and undefined. Recurses into plain objects and arrays.
 */
export function sanitizeDraft<T>(value: T): T {
  const clean = (v: unknown): unknown => {
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined
    if (typeof Blob !== 'undefined' && v instanceof Blob) return undefined
    if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_KEY.test(k)) continue
        const c = clean(val)
        if (c !== undefined) out[k] = c
      }
      return out
    }
    return v
  }
  return clean(value) as T
}

/** True when nothing worth keeping is in the draft: all strings blank, arrays empty, flags false. */
export function isDraftEmpty(data: unknown, ignore: string[] = []): boolean {
  if (data == null) return true
  if (typeof data === 'string') return data.trim() === ''
  if (typeof data === 'boolean') return !data
  if (typeof data === 'number') return false
  if (Array.isArray(data)) return data.every((d) => isDraftEmpty(d))
  if (typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).every(([k, v]) => ignore.includes(k) || isDraftEmpty(v))
  }
  return false
}

export function saveDraft<T>(storage: StorageLike | null, key: string, data: T, now: number = Date.now()): boolean {
  if (!storage) return false
  try {
    const envelope: Envelope<T> = { v: 1, savedAt: now, data: sanitizeDraft(data) }
    storage.setItem(key, JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}

export interface LoadedDraft<T> {
  data: T
  savedAt: number
}

/** Returns the stored draft, or null when missing, malformed or older than the TTL (expired drafts are removed). */
export function loadDraft<T>(storage: StorageLike | null, key: string, now: number = Date.now(), ttl: number = DRAFT_TTL_MS): LoadedDraft<T> | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Envelope<T>>
    if (!parsed || parsed.v !== 1 || typeof parsed.savedAt !== 'number' || !('data' in parsed)) {
      storage.removeItem(key)
      return null
    }
    if (now - parsed.savedAt > ttl || parsed.savedAt > now + 60_000) {
      storage.removeItem(key)
      return null
    }
    return { data: parsed.data as T, savedAt: parsed.savedAt }
  } catch {
    try { storage.removeItem(key) } catch { /* ignore */ }
    return null
  }
}

export function clearDraft(storage: StorageLike | null, key: string): void {
  if (!storage) return
  try { storage.removeItem(key) } catch { /* ignore */ }
}

/** Removes every expired or unreadable draft. Returns how many were deleted. */
export function purgeExpiredDrafts(storage: StorageLike | null, now: number = Date.now(), ttl: number = DRAFT_TTL_MS): number {
  if (!storage) return 0
  let removed = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      if (loadDraft(storage, k, now, ttl) === null && storage.getItem(k) === null) removed++
    }
  } catch {
    /* ignore */
  }
  return removed
}

/** Trailing-edge debounce with flush and cancel; the timer functions can be injected for tests. */
export function createDebouncer<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  timers: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (f, d) => setTimeout(f, d),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let handle: unknown = null
  let pending: A | null = null
  const run = () => {
    handle = null
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
    }
  }
  return {
    call(...args: A) {
      pending = args
      if (handle !== null) timers.clear(handle)
      handle = timers.set(run, ms)
    },
    flush() {
      if (handle !== null) timers.clear(handle)
      run()
    },
    cancel() {
      if (handle !== null) timers.clear(handle)
      handle = null
      pending = null
    },
    get pending() { return pending !== null },
  }
}

/** Short human text for the restore bar, for example "Draft from 5 minutes ago". */
export function describeDraftAge(savedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** Description-field draft: one per user and issue (an edit of the description in the issue view). */
export function descriptionDraftKey(userId: number | string, issueKey: string): string {
  return `${DRAFT_PREFIX}description:${part(userId)}:${part(issueKey)}`
}

/**
 * One autosaving draft slot, without React. `update` is called on every change (debounced save, or removal when the
 * content is empty), `restore` reads the stored draft once, `clear` is called after a successful submit and makes
 * later `update` calls no-ops until `reopen`.
 */
export function createDraftSession<T>(opts: {
  storage: StorageLike | null
  key: string
  isEmpty?: (data: T) => boolean
  debounceMs?: number
  now?: () => number
  timers?: Parameters<typeof createDebouncer>[2]
}) {
  const { storage, key } = opts
  const now = opts.now ?? (() => Date.now())
  const isEmpty = opts.isEmpty ?? ((d: T) => isDraftEmpty(d))
  let closed = false
  const write = (data: T) => {
    if (closed) return
    if (isEmpty(data)) clearDraft(storage, key)
    else saveDraft(storage, key, data, now())
  }
  const debouncer = createDebouncer(write, opts.debounceMs ?? DRAFT_DEBOUNCE_MS, opts.timers)
  return {
    restore(): LoadedDraft<T> | null {
      const d = loadDraft<T>(storage, key, now())
      if (d && isEmpty(d.data)) { clearDraft(storage, key); return null }
      return d
    },
    update(data: T) { if (!closed) debouncer.call(data) },
    flush() { debouncer.flush() },
    clear() { closed = true; debouncer.cancel(); clearDraft(storage, key) },
    reopen() { closed = false },
    get pending() { return debouncer.pending },
  }
}
