'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bug, GitBranch, BookOpen, Layers, CheckCircle2, ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { normalizeCategory, CATEGORY_LABEL, relativeTime } from '@/lib/issue-view'
import { Skeleton } from '@/components/skeleton'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'

/* ------------------------------------------------------------------ */
/*  Status lozenge (Jira style: uppercase, coloured by category)       */
/* ------------------------------------------------------------------ */

const LOZENGE_CLASS = {
  todo: 'veqsio-badge-status-todo',
  in_progress: 'veqsio-badge-status-inprogress',
  done: 'veqsio-badge-status-done',
} as const

export function StatusLozenge({
  name,
  category,
  caret = false,
  className = '',
}: {
  name: string
  category?: string | null
  caret?: boolean
  className?: string
}) {
  const cat = normalizeCategory(category)
  return (
    <span
      className={`veqsio-badge ${LOZENGE_CLASS[cat]} inline-flex items-center gap-1 uppercase tracking-wide font-semibold text-[11px] leading-5 ${className}`}
      title={`${name} (${CATEGORY_LABEL[cat]})`}
    >
      <span className="truncate max-w-[16rem]">{name}</span>
      {caret && <ChevronDown className="w-3.5 h-3.5 -mr-0.5" aria-hidden="true" />}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Issue type icon                                                    */
/* ------------------------------------------------------------------ */

export function IssueTypeIcon({ name, className = '' }: { name?: string | null; className?: string }) {
  return <IssueTypeGlyph name={name} className={className} />
}

/* ------------------------------------------------------------------ */
/*  Popover: outside click, Escape, aria-expanded on the trigger       */
/* ------------------------------------------------------------------ */

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'left',
  panelClassName = '',
  className = '',
  label,
  haspopup = 'dialog',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Rendered inside a wrapper; receives aria props for the trigger button. */
  trigger: (props: { 'aria-haspopup': 'menu' | 'listbox' | 'dialog'; 'aria-expanded': boolean; onClick: () => void }) => ReactNode
  children: ReactNode
  align?: 'left' | 'right'
  panelClassName?: string
  className?: string
  label: string
  haspopup?: 'menu' | 'listbox' | 'dialog'
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange(false)
        ref.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  return (
    <div className={`relative ${className}`} ref={ref}>
      {trigger({ 'aria-haspopup': haspopup, 'aria-expanded': open, onClick: () => onOpenChange(!open) })}
      {open && (
        <div
          role={haspopup}
          aria-label={label}
          className={`absolute z-40 mt-1 ${align === 'right' ? 'right-0' : 'left-0'} bg-[var(--surface-0)] border border-[var(--surface-3)] rounded-lg shadow-lg ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Collapsible section for the details panel                          */
/* ------------------------------------------------------------------ */

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  actions,
  id,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  actions?: ReactNode
  id: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Remember per-section state for this viewer only (nice to have; never required).
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(`veqsio:issue-section:${id}`)
      if (v === '0') setOpen(false)
      if (v === '1') setOpen(true)
    } catch {
      /* storage unavailable */
    }
  }, [id])
  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(`veqsio:issue-section:${id}`, o ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !o
    })
  }
  const panelId = `section-${id}`
  return (
    <section className="border border-[var(--surface-3)] rounded-lg bg-[var(--surface-0)]">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex items-center gap-1.5 text-body-sm font-semibold text-[var(--text-primary)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          {open ? <ChevronDown className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />}
          {title}
        </button>
        {actions}
      </div>
      {open && (
        <div id={panelId} className="px-3 pb-3 space-y-1">
          {children}
        </div>
      )}
    </section>
  )
}

/** One label/value row in the details panel. */
export function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-2 min-h-[2rem]">
      <label htmlFor={htmlFor} className="text-caption text-[var(--text-tertiary)] pt-1.5 truncate" title={label}>
        {label}
      </label>
      <div className="min-w-0 text-body-sm text-[var(--text-primary)]">{children}</div>
    </div>
  )
}

/** Button that looks like plain text until hovered (Jira's inline-edit affordance). */
export function InlineValueButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className={`group w-full flex items-start gap-2 text-left rounded px-1.5 py-1 -mx-1.5 hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-colors ${className}`}
    >
      <span className="flex-1 min-w-0">{children}</span>
      <Pencil className="w-3 h-3 mt-1 shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" aria-hidden="true" />
    </button>
  )
}

export function Lozenge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'brand' }) {
  const tones = {
    neutral: 'bg-[var(--surface-2)] text-[var(--text-secondary)]',
    success: 'bg-[var(--surface-2)] text-[var(--success)]',
    warning: 'bg-[var(--surface-2)] text-[var(--warning)]',
    brand: 'bg-[var(--brand-50)] text-[var(--brand-600)]',
  }
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

/** Relative time with the full date as tooltip, as in Jira ("3 hours ago"). */
export function RelativeTime({ date, className = '' }: { date: string | Date | null | undefined; className?: string }) {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return null
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString(getIntlLocale())} className={className}>
      {relativeTime(d)}
    </time>
  )
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton for the whole page                                */
/* ------------------------------------------------------------------ */

export function IssueViewSkeleton() {
  const { tr } = useI18n();

  return (
    <div className="space-y-6" role="status" aria-label={tr('Loading issue')}>
      <Skeleton className="h-4 w-56" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28 ml-4" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6">
        <div className="space-y-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
      <span className="sr-only">{tr('Loading issue')}</span>
    </div>
  )
}
