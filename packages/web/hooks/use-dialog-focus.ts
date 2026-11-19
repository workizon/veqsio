'use client'

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for a modal dialog: remembers the element that had focus, moves focus into the dialog,
 * keeps Tab inside it, and gives focus back on close. `initialFocus` defaults to the first focusable element.
 */
export function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>, initialFocus?: RefObject<HTMLElement | null>) {
  const previous = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => {
      const target = initialFocus?.current ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? dialogRef.current
      target?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      const el = previous.current
      previous.current = null
      // let the dialog unmount first so the browser does not scroll to a hidden element
      // (skipped when the dialog is still mounted: React strict mode re-runs effects in development)
      if (el && document.contains(el)) setTimeout(() => { if (dialogRef.current?.isConnected) return; el.focus({ preventScroll: true }) }, 0)
    }
  }, [open, dialogRef, initialFocus])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const root = dialogRef.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (items.length === 0) { e.preventDefault(); root.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dialogRef])
}
