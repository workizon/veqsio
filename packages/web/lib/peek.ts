/**
 * Peek view URL handling: the issue list, board and backlog keep their own URL and add `?peek=KEY`, so the
 * peeked issue is shareable and the browser back button closes it. Pure helpers, no DOM access.
 */

export const PEEK_PARAM = 'peek'
export type PeekMode = 'side' | 'modal'
export const PEEK_MODE_STORAGE_KEY = 'veqsio-peek-mode'

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/

/** A valid issue key (upper-cased) or null. Anything else in the URL is ignored. */
export function parsePeekKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim()
  return KEY_RE.test(v) ? v.toUpperCase() : null
}

/** New query string (with leading `?`, or '') with the peek parameter set or removed; other parameters are kept as they are. */
export function withPeek(search: string, key: string | null): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const valid = parsePeekKey(key)
  if (valid) params.set(PEEK_PARAM, valid)
  else params.delete(PEEK_PARAM)
  const s = params.toString()
  return s ? `?${s}` : ''
}

export function parsePeekMode(raw: string | null | undefined): PeekMode {
  return raw === 'modal' ? 'modal' : 'side'
}
