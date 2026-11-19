'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import type { MoveTarget } from '@/lib/planning'

export interface MoveOption {
  id: string
  label: string
  hint?: string
  target: MoveTarget
}

interface MoveMenuProps {
  options: MoveOption[]
  onSelect: (target: MoveTarget) => void
  /** Accessible name of the trigger, e.g. "Move PROJ-12 to…". */
  label: string
  /** Visible text next to the icon (bulk toolbar); omitted in rows. */
  text?: string
  disabled?: boolean
  className?: string
}

/**
 * Accessible "Move to…" menu: button with aria-haspopup, arrow-key navigation, Escape closes and
 * returns focus. The panel is positioned with `fixed` so lists with overflow never clip it.
 */
export function MoveMenu({ options, onSelect, label, text, disabled, className = '' }: MoveMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number }>({ right: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }, [])

  const toggle = () => {
    if (open) return close(false)
    const r = trigger.current?.getBoundingClientRect()
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom
      const right = Math.max(8, window.innerWidth - r.right)
      setPos(spaceBelow < 260 && r.top > spaceBelow ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right })
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={toggle}
        className={`veqsio-btn-ghost inline-flex items-center gap-1.5 px-1.5 py-1 text-xs ${className}`}
      >
        <ArrowRightLeft className="w-3.5 h-3.5" aria-hidden="true" />
        {text && <span>{text}</span>}
      </button>
      {open && (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          style={{ position: 'fixed', zIndex: 60, ...pos }}
          className="min-w-[200px] max-w-[280px] max-h-72 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-lg)] py-1"
        >
          {options.length === 0 && <div className="px-3 py-2 text-caption text-[var(--text-tertiary)]">Nowhere to move to</div>}
          {options.map((o) => (
            <button
              key={o.id}
              role="menuitem"
              type="button"
              onClick={() => { setOpen(false); onSelect(o.target) }}
              className="w-full text-left px-3 py-1.5 text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none flex items-center justify-between gap-3"
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="text-caption text-[var(--text-tertiary)] shrink-0">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
