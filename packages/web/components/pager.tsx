'use client'


import { useI18n } from '@/hooks/use-i18n'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Props {
  startAt: number
  pageSize: number
  total: number
  shown: number
  onPage: (startAt: number) => void
  className?: string
}

/** "1-50 of 50,000" with previous / next, for lists that are paged on the server. */
export function Pager({ startAt, pageSize, total, shown, onPage, className = '' }: Props) {
  const { tr } = useI18n();

  if (total <= pageSize && startAt === 0) return null
  const from = shown === 0 ? 0 : startAt + 1
  const to = startAt + shown
  const fmt = (n: number) => n.toLocaleString()
  return (
    <div className={`flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)] ${className}`}>
      <span aria-live="polite">{fmt(from)}–{fmt(to)} {tr('of')} {fmt(total)}</span>
      <div className="flex items-center gap-1">
        <button type="button" className="veqsio-btn-secondary px-2 py-1 disabled:opacity-40" disabled={startAt === 0} onClick={() => onPage(Math.max(0, startAt - pageSize))} aria-label={tr('Previous page')}><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" className="veqsio-btn-secondary px-2 py-1 disabled:opacity-40" disabled={to >= total} onClick={() => onPage(startAt + pageSize)} aria-label={tr('Next page')}><ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  )
}
