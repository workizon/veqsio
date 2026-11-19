'use client'

import { useEffect, useRef } from 'react'
import { assertKnownHandlers, registerShortcuts, type HandlerMap, type ShortcutContext } from '@/lib/shortcuts'

/**
 * Registers key handlers for a context from the shortcut table (lib/shortcuts.ts).
 * Handlers are keyed by the table id, e.g. `{ 'issueList.next': () => ... }`. Handlers may change on every
 * render; the latest ones are always used. Return `false` from a handler to leave the key to the browser.
 */
export function useShortcuts(context: ShortcutContext, handlers: HandlerMap, enabled = true) {
  const ref = useRef(handlers)
  ref.current = handlers
  if (process.env.NODE_ENV !== 'production') assertKnownHandlers(context, handlers)

  useEffect(() => {
    if (!enabled) return
    return registerShortcuts(context, () => ref.current)
  }, [context, enabled])
}
