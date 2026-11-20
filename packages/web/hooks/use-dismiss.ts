import { useEffect, useRef } from 'react'

/**
 * Closes a popup (dropdown, menu, suggestion list) when the user presses outside of it or hits Escape.
 * Put the returned ref on the element that wraps BOTH the trigger and the popup, so a click on the trigger is not "outside".
 *   const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close.current() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [open])
  return ref
}
