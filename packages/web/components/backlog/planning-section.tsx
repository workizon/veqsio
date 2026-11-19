'use client'

import { useDroppable } from '@dnd-kit/core'
import { CheckCircle2, ChevronDown, Pencil, Play, Trash2 } from 'lucide-react'
import { IssueRow } from './issue-row'
import { InlineCreate } from './inline-create'
import type { MoveOption } from './move-menu'
import {
  BACKLOG_DROP_ID, formatPoints, formatSprintDates, pluralize, pointsByCategory, sprintDropId,
  type MoveTarget, type PlanIssue, type PlanSprint,
} from '@/lib/planning'
import { useTerm } from '@/hooks/use-term'

interface SectionProps {
  /** Present for sprints, absent for the backlog. */
  sprint?: PlanSprint
  title: string
  /** Issues after filters. */
  issues: PlanIssue[]
  /** Totals before filters (what the header shows). */
  totalCount: number
  totalPoints: number
  filtered: boolean
  expanded: boolean
  onToggle: () => void
  selected: ReadonlySet<string>
  onToggleSelect: (key: string) => void
  onSelectAll: (keys: string[], on: boolean) => void
  moveOptionsFor: (key: string) => MoveOption[]
  onMove: (keys: string[], target: MoveTarget) => void
  ghostKeys: ReadonlySet<string>
  onStart?: () => void
  onComplete?: () => void
  onEdit?: () => void
  onDelete?: () => void
  createPending: boolean
  onCreateIssue: (input: { summary: string; issueTypeId: number; typeName: string }) => Promise<unknown>
  onPeek?: (key: string) => void
  backlogMore?: { shown: number; total: number; loading: boolean; onLoadMore: () => void }
}

const stateBadge = {
  active: ['veqsio-badge-status-inprogress', 'Active'],
  future: ['veqsio-badge-status-todo', 'Planned'],
  closed: ['veqsio-badge-status-done', 'Completed'],
} as const

export function PlanningSection(p: SectionProps) {
  const { t } = useTerm()
  const dropId = p.sprint ? sprintDropId(p.sprint.id) : BACKLOG_DROP_ID
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  const regionId = `section-${dropId}`
  const allSelected = p.issues.length > 0 && p.issues.every((i) => p.selected.has(i.key))
  const someSelected = p.issues.some((i) => p.selected.has(i.key))
  const byCat = pointsByCategory(p.issues.length ? p.issues : [])
  const [badgeClass, badgeText] = p.sprint ? stateBadge[p.sprint.state] : [null, null]

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`${regionId}-title`}
      className={`rounded-lg border bg-[var(--surface-0)] transition-colors ${isOver ? 'border-[var(--brand-500)] ring-2 ring-[var(--brand-200)]' : 'border-[var(--surface-3)]'}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 bg-[var(--surface-1)] rounded-t-lg">
        <button
          type="button"
          onClick={p.onToggle}
          aria-expanded={p.expanded}
          aria-controls={regionId}
          className="flex items-center gap-2 min-w-0 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <ChevronDown className={`w-4 h-4 shrink-0 text-[var(--text-tertiary)] transition-transform ${p.expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
          <h3 id={`${regionId}-title`} className="text-heading-3 text-[var(--text-primary)] truncate">{p.title}</h3>
          {badgeClass && <span className={`veqsio-badge ${badgeClass} text-xs`}>{badgeText}</span>}
        </button>

        <div className="flex items-center gap-2 text-caption text-[var(--text-tertiary)] flex-wrap">
          {p.sprint && <span>{formatSprintDates(p.sprint.startDate, p.sprint.endDate)}</span>}
          <span>
            {p.filtered ? `${p.issues.length} of ${pluralize(p.totalCount, 'issue')}` : pluralize(p.totalCount, 'issue')}
            {' · '}
            {formatPoints(p.totalPoints)} {p.totalPoints === 1 ? 'point' : 'points'}
          </span>
          {p.sprint && p.sprint.issues.length > 0 && !p.filtered && (
            <span className="flex items-center gap-1" aria-label={`Points: ${byCat.todo} to do, ${byCat.in_progress} in progress, ${byCat.done} done`}>
              <span className="rounded-full px-1.5 bg-[var(--surface-3)] text-[var(--text-secondary)]" title="To do points">{formatPoints(byCat.todo)}</span>
              <span className="rounded-full px-1.5 bg-[var(--brand-100)] text-[var(--brand-700)]" title="In progress points">{formatPoints(byCat.in_progress)}</span>
              <span className="rounded-full px-1.5 bg-[var(--success)]/15 text-[var(--success)]" title="Done points">{formatPoints(byCat.done)}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          {p.onEdit && (
            <button type="button" onClick={p.onEdit} className="veqsio-btn-ghost p-1.5" aria-label={`Edit ${p.title}`} title="Edit sprint">
              <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          {p.onDelete && (
            <button type="button" onClick={p.onDelete} className="veqsio-btn-ghost p-1.5" aria-label={`Delete ${p.title}`} title="Delete sprint">
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          {p.onStart && (
            <button type="button" onClick={p.onStart} className="veqsio-btn-primary text-xs inline-flex items-center gap-1">
              <Play className="w-3 h-3" aria-hidden="true" /> Start sprint
            </button>
          )}
          {p.onComplete && (
            <button type="button" onClick={p.onComplete} className="veqsio-btn-secondary text-xs inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Complete sprint
            </button>
          )}
        </div>
      </div>

      {p.sprint?.goal && p.expanded && (
        <p className="px-3 py-1.5 text-caption text-[var(--text-secondary)] border-t border-[var(--surface-3)]">
          <span className="font-medium">Goal:</span> {p.sprint.goal}
        </p>
      )}

      {p.expanded && (
        <div id={regionId} className="border-t border-[var(--surface-3)]">
          {p.issues.length > 0 && (
            <label className="flex items-center gap-2 px-3 py-1 text-caption text-[var(--text-tertiary)] border-b border-[var(--surface-3)]">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                onChange={(e) => p.onSelectAll(p.issues.map((i) => i.key), e.target.checked)}
                className="w-4 h-4 accent-[var(--brand-600)]"
              />
              Select all in {p.title}
            </label>
          )}
          {p.issues.length === 0 ? (
            <div className="px-4 py-8 text-center text-caption text-[var(--text-tertiary)]">
              {p.filtered
                ? t('No issues match the current filters')
                : p.sprint
                  ? t('This sprint is empty. Drag issues here from the backlog, or use “Move to…” on an issue.')
                  : t('The backlog is empty. Create an issue below to get started.')}
            </div>
          ) : (
            <div role="list" aria-label={`${p.title} issues`}>
              {p.issues.map((issue) => (
                <div role="listitem" key={issue.key}>
                  <IssueRow
                    issue={issue}
                    containerId={dropId}
                    selected={p.selected.has(issue.key)}
                    onToggleSelect={p.onToggleSelect}
                    moveOptions={p.moveOptionsFor(issue.key)}
                    onMove={(key, target) => p.onMove([key], target)}
                    ghost={p.ghostKeys.has(issue.key)}
                    onPeek={p.onPeek}
                  />
                </div>
              ))}
            </div>
          )}
          {p.backlogMore && p.backlogMore.shown < p.backlogMore.total && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-[var(--surface-3)] text-caption text-[var(--text-tertiary)]">
              <span>Showing {p.backlogMore.shown} of {p.backlogMore.total} issues</span>
              <button type="button" onClick={p.backlogMore.onLoadMore} disabled={p.backlogMore.loading} className="veqsio-btn-secondary text-xs">
                {p.backlogMore.loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
          <div className="border-t border-[var(--surface-3)] rounded-b-lg overflow-hidden">
            <InlineCreate where={p.title} pending={p.createPending} onCreate={p.onCreateIssue} />
          </div>
        </div>
      )}
    </section>
  )
}
