'use client'

import { useCallback, useEffect, useState } from 'react'
import { parsePeekKey, withPeek } from '@/lib/peek'

const EVENT = 'veqsio:peek'

/**
 * Peek state kept in the URL (`?peek=KEY`) so a peeked issue can be shared and the back button closes it.
 * Uses the History API directly (no useSearchParams), so pages need no Suspense boundary; Next keeps its own
 * router state in sync with pushState / replaceState.
 */
export function usePeek() {
  const [peekKey, setPeekKey] = useState<string | null>(null)

  useEffect(() => {
    const sync = () => setPeekKey(parsePeekKey(new URLSearchParams(window.location.search).get('peek')))
    sync()
    window.addEventListener('popstate', sync)
    window.addEventListener(EVENT, sync)
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener(EVENT, sync) }
  }, [])

  const open = useCallback((key: string) => {
    const search = withPeek(window.location.search, key)
    if (search === window.location.search) { window.dispatchEvent(new Event(EVENT)); return }
    const url = `${window.location.pathname}${search}${window.location.hash}`
    // Already peeking: swap the issue in place so one Esc / back closes the panel whatever was peeked.
    if (parsePeekKey(new URLSearchParams(window.location.search).get('peek'))) window.history.replaceState(window.history.state, '', url)
    else window.history.pushState({ ...(window.history.state ?? {}), __peek: true }, '', url)
    window.dispatchEvent(new Event(EVENT))
  }, [])

  const close = useCallback(() => {
    // Opened from this page: step back so the history does not fill up with identical list entries.
    if (window.history.state?.__peek) { window.history.back(); return }
    const search = withPeek(window.location.search, null)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`)
    window.dispatchEvent(new Event(EVENT))
  }, [])

  return { peekKey, open, close }
}
