'use client'


import { useI18n } from '@/hooks/use-i18n'
import type { MouseEvent, ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { SortDir } from '@/lib/table-sort'

interface Props {
  dir: SortDir | null
  /** Receives the click, so Shift/Ctrl/Cmd+click can add the column as an extra sort key */
  onToggle: (e: MouseEvent) => void
  /** 1-based sort priority, shown when several columns are sorted */
  rank?: number
  className?: string
  scope?: 'col' | 'row'
  children: ReactNode
}

/** A column header that sorts the table when clicked. Shift+click adds it as a further sort column. */
export function SortableTh({ dir, onToggle, rank, className, scope = 'col', children }: Props) {
  const { tr } = useI18n();

  return (
    <th scope={scope} className={className} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
      <button
        type="button"
        onClick={onToggle}
        title={tr('Click to sort. Shift+click to sort by several columns.')}
        className="inline-flex items-center gap-1 font-inherit hover:text-[var(--text-primary)]"
      >
        {children}
        {dir === 'asc' && <ArrowUp className="h-3 w-3" aria-hidden />}
        {dir === 'desc' && <ArrowDown className="h-3 w-3" aria-hidden />}
        {rank !== undefined && <span className="rounded bg-[var(--surface-2)] px-1 text-[10px] leading-4 text-[var(--text-secondary)]" aria-label={`sort priority ${rank}`}>{rank}</span>}
      </button>
    </th>
  )
}
