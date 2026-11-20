'use client'

import { useState } from 'react'
import { useI18n } from '@/hooks/use-i18n'
import { Flag, MoreHorizontal } from 'lucide-react'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'
import { PriorityBadge } from '@/components/priority-badge'
import { Avatar } from '@/components/avatar'
import { Popover } from '@/components/issue/primitives'
import type { CardLayout } from '@/lib/card-layout'
import { cardColourStyle, type CardColourToken } from '@/lib/card-colours'

export interface BoardCardIssue {
  key: string
  fields: {
    summary: string
    issuetype?: { name: string } | null
    priority?: { name: string } | null
    assignee?: { displayName: string } | null
    labels?: string[]
    storyPoints?: number | string | null
    flagged?: boolean
  }
}

/**
 * One card on a board column. Summary first; the metadata row stays one line so cards have an even rhythm.
 * `colour` is a palette token for the left border and tint (board setting "Card colour by"); a flagged issue
 * (impediment) gets a flag icon, a warning tint and a visible label, so colour is never the only signal.
 */
export function BoardCard({ issue, colour, colourReason, onToggleFlag, layout, moves }: {
  /** Moves to the neighbouring columns, offered in the actions menu (the keyboard and screen reader way to do what a swipe does) */
  moves?: Array<{ label: string; onSelect: () => void }>
  /** which optional parts to show (board setting "Card layout"); default all */
  layout?: CardLayout
  issue: BoardCardIssue
  colour?: CardColourToken | null
  colourReason?: string
  onToggleFlag?: (key: string, flagged: boolean) => void
}) {
  const { summary, issuetype, priority, assignee, labels, storyPoints } = issue.fields
  const flagged = issue.fields.flagged === true
  const show = (f: Parameters<CardLayout['fields']['has']>[0]) => !layout || layout.fields.has(f)
  const compact = layout?.size === 'compact'
  const [menuOpen, setMenuOpen] = useState(false)
  const { tr } = useI18n()
  const flagStyle = flagged ? { backgroundImage: 'linear-gradient(color-mix(in srgb, var(--warning) 16%, transparent), color-mix(in srgb, var(--warning) 16%, transparent))' } : {}
  return (
    <div
      data-flagged={flagged || undefined}
      data-card-colour={colour || undefined}
      title={colourReason}
      style={{ ...cardColourStyle(colour), ...flagStyle }}
      className={`group relative rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2.5'} shadow-[var(--shadow-sm)] cursor-grab active:cursor-grabbing transition-[border-color,box-shadow,transform] duration-150 hover:border-[var(--surface-4)] hover:shadow-[var(--shadow-md)] motion-safe:hover:-translate-y-px`}
    >
      {flagged && (
        <span className="mb-1.5 inline-flex items-center gap-1 rounded bg-[var(--warning)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--warning)]">
          <Flag className="w-3 h-3" aria-hidden="true" /> {tr('Flagged')} </span>
      )}
      <p className="text-[13px] leading-[18px] font-medium text-[var(--text-primary)] line-clamp-2 pr-6">{summary}</p>
      {onToggleFlag && (
        <div
          className={`absolute right-1.5 top-1.5 ${menuOpen ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'} transition-opacity`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
        >
          <Popover
            open={menuOpen}
            onOpenChange={setMenuOpen}
            label={tr('Actions for {key}', { key: issue.key })}
            haspopup="menu"
            align="right"
            panelClassName="min-w-[10rem] py-1 z-20"
            trigger={(p) => (
              <button type="button" {...p} aria-label={tr('Actions for {key}', { key: issue.key })} className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          >
            {moves?.map((m) => (
              <button
                key={m.label}
                role="menuitem"
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none"
                onClick={() => { setMenuOpen(false); m.onSelect() }}
              >
                {m.label}
              </button>
            ))}
            <button
              role="menuitem"
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none"
              onClick={() => { setMenuOpen(false); onToggleFlag(issue.key, !flagged) }}
            >
              <Flag className="w-4 h-4" aria-hidden="true" /> {flagged ? tr('Remove flag') : tr('Add flag')}
            </button>
          </Popover>
        </div>
      )}
      {show('labels') && !!labels?.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          {labels.slice(0, 2).map((l) => (
            <span key={l} className="max-w-[110px] truncate rounded px-1.5 py-0.5 text-[11px] leading-4 bg-[var(--surface-2)] text-[var(--text-secondary)]">{l}</span>
          ))}
          {labels.length > 2 && <span className="text-[11px] leading-5 text-[var(--text-tertiary)]">+{labels.length - 2}</span>}
        </div>
      )}
      <div className={`${compact ? 'mt-1.5' : 'mt-2.5'} flex items-center gap-2`}>
        {show('issuetype') && <IssueTypeGlyph name={issuetype?.name} size={14} />}
        <span className="text-[12px] font-medium tabular-nums text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]">{issue.key}</span>
        <span className="ml-auto flex items-center gap-2">
          {show('storyPoints') && storyPoints !== null && storyPoints !== undefined && (
            <span className="min-w-[1.25rem] rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-center text-[11px] font-medium text-[var(--text-secondary)]" title={tr('{n} story points', { n: Number(storyPoints) })}>{Number(storyPoints)}</span>
          )}
          {show('priority') && priority && <PriorityBadge priority={priority.name} iconOnly />}
          {!show('assignee') ? null : assignee ? (
            <Avatar name={assignee.displayName} size="sm" />
          ) : (
            <span className="w-5 h-5 rounded-full border border-dashed border-[var(--surface-4)]" title={tr('Unassigned')} aria-label={tr('Unassigned')} />
          )}
        </span>
      </div>
    </div>
  )
}
