'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDraftSession, getSafeStorage, purgeExpiredDrafts } from '@/lib/drafts'

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? '' } catch { return '' }
}

export interface DraftRestored { savedAt: number }

/**
 * Autosaves a form into localStorage (see lib/drafts.ts) and restores it when the form is opened again.
 *
 *   const draft = useDraft({ key, value: { summary, description }, onRestore: (d) => { setSummary(d.summary) ... } })
 *   draft.restored  -> { savedAt } while the "Restored draft from ..." notice should show
 *   draft.discard() -> remove the draft and let the caller reset its fields (onDiscard)
 *   draft.clear()   -> call after a successful submit
 *
 * `key` null disables the draft (for example while the user id is still loading). Never throws when storage is blocked.
 */
export function useDraft<T>(opts: {
  key: string | null
  value: T
  onRestore: (data: T) => void
  onDiscard?: () => void
  isEmpty?: (data: T) => boolean
  enabled?: boolean
}) {
  const { key, value, enabled = true } = opts
  const serialized = safeJson(value)
  const [restored, setRestored] = useState<DraftRestored | null>(null)
  const sessionRef = useRef<ReturnType<typeof createDraftSession<T>> | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const readyRef = useRef(false)
  // The form as it was when the draft was read. Nothing is written (or deleted) until the form differs from it, so a
  // remount (React strict mode, navigation) never wipes a stored draft with the still-empty initial form.
  const baselineRef = useRef('')
  const dirtyRef = useRef(false)

  useEffect(() => {
    readyRef.current = false
    dirtyRef.current = false
    baselineRef.current = safeJson(latest.current.value)
    setRestored(null)
    if (!key || !enabled) { sessionRef.current = null; return }
    const storage = getSafeStorage()
    const session = createDraftSession<T>({ storage, key, isEmpty: latest.current.isEmpty })
    sessionRef.current = session
    purgeExpiredDrafts(storage)
    const found = session.restore()
    if (found) {
      latest.current.onRestore(found.data)
      setRestored({ savedAt: found.savedAt })
    }
    readyRef.current = true
    return () => {
      // keep the last keystrokes when the form unmounts (navigation) unless it was cleared
      session.flush()
      sessionRef.current = null
    }
  }, [key, enabled])

  // Save after every change, but not before the stored draft was read (that would overwrite it with the empty form).
  useEffect(() => {
    if (!readyRef.current) return
    if (!dirtyRef.current) {
      if (serialized === baselineRef.current) return
      dirtyRef.current = true
    }
    sessionRef.current?.update(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized])

  const clear = useCallback(() => {
    sessionRef.current?.clear()
    // "create another" keeps the form open: later edits must be saved again
    sessionRef.current?.reopen()
    setRestored(null)
  }, [])

  const discard = useCallback(() => {
    sessionRef.current?.clear()
    sessionRef.current?.reopen()
    setRestored(null)
    latest.current.onDiscard?.()
  }, [])

  const dismissNotice = useCallback(() => setRestored(null), [])

  return { restored, clear, discard, dismissNotice }
}
