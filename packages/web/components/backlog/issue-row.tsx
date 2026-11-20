'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'
import { useRouter } from 'next/navigation'
import { memo } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Bug, GitBranch, BookOpen, Layers, CheckCircle2, GripVertical, Flag } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { Avatar } from '@/components/avatar'
import { MoveMenu, type MoveOption } from './move-menu'
import { PeekButton } from '@/components/issue/peek-view'
import { formatPoints, issueDragId, type MoveTarget, type PlanIssue } from '@/lib/planning'

const typeIcon = {
  bug: { Icon: Bug, color: 'text-[var(--error)]' },
  story: { Icon: BookOpen, color: 'text-[var(--success)]' },
  epic: { Icon: Layers, color: 'text-[var(--warning)]' },
  'sub-task': { Icon: GitBranch, color: 'text-[var(--text-tertiary)]' },
  task: { Icon: CheckCircle2, color: 'text-[var(--brand-500)]' },
} as const

const categoryToBadge = { todo: 'to_do', in_progress: 'in_progress', done: 'done' } as const

interface IssueRowProps {
  issue: PlanIssue
  /** Droppable id of the section the row lives in (used when dropping onto this row). */
  containerId: string
  selected: boolean
  onToggleSelect: (key: string) => void
  moveOptions: MoveOption[]
  onMove: (key: string, target: MoveTarget) => void
  /** True while any selected row is being dragged (the whole selection moves). */
  ghost?: boolean
  /** Opens the issue in the peek panel (the page keeps its URL, plus ?peek=KEY). */
  onPeek?: (key: string) => void
}

export const IssueRow = memo(function IssueRow({ issue, containerId, selected, onToggleSelect, moveOptions, onMove, ghost, onPeek }: IssueRowProps) {
  const { tr } = useI18n();

  const router = useRouter()
  const drag = useDraggable({ id: issueDragId(issue.key), data: { key: issue.key, containerId } })
  const drop = useDroppable({ id: `row:${issue.key}`, data: { key: issue.key, containerId } })

  const openIssue = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a,button,input,label,[role="menu"]')) return
    router.push(`/issues/${issue.key}`)
  }

  const showDropLine = drop.isOver && !drag.isDragging
  return (
    <div
      ref={(node) => { drag.setNodeRef(node); drop.setNodeRef(node) }}
      onClick={openIssue}
      data-issue-key={issue.key}
      data-flagged={issue.flagged || undefined}
      className={[
        'group relative flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 px-2 py-2 sm:py-1.5 border-b border-[var(--surface-3)] last:border-b-0 cursor-pointer',
        'hover:bg-[var(--surface-2)] transition-colors',
        selected ? 'bg-[var(--brand-50)]' : issue.flagged ? 'bg-[var(--warning)]/10' : '',
        drag.isDragging || ghost ? 'opacity-40' : '',
        showDropLine ? 'before:absolute before:left-0 before:right-0 before:top-0 before:h-0.5 before:bg-[var(--brand-500)]' : '',
      ].join(' ')}
    >
      <button
        ref={drag.setActivatorNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        type="button"
        aria-label={tr('Drag {key}. Press space to pick up, arrow keys to move, space to drop.', { key: issue.key })}
        className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-grab active:cursor-grabbing touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
      >
        <GripVertical className="w-4 h-4" aria-hidden="true" />
      </button>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(issue.key)}
        aria-label={tr('Select {key}', { key: issue.key })}
        className="shrink-0 w-4 h-4 accent-[var(--brand-600)]"
      />
      <IssueTypeGlyph name={issue.typeName || issue.type} />
      <Link href={`/issues/${issue.key}`} className="shrink-0 py-2 sm:py-0 text-caption font-medium text-[var(--text-secondary)] hover:text-[var(--brand-600)] hover:underline w-20 truncate">
        {issue.key}
      </Link>
      {issue.flagged && <Flag className="shrink-0 w-3.5 h-3.5 text-[var(--warning)]" aria-label={tr('Flagged')} />}
      <Link href={`/issues/${issue.key}`} className="order-last basis-full py-1.5 pl-1 text-body-sm text-[var(--text-primary)] hover:underline sm:order-none sm:basis-auto sm:flex-1 sm:min-w-0 sm:truncate sm:pl-0">
        {issue.summary}
      </Link>
      {onPeek && <PeekButton issueKey={issue.key} onPeek={onPeek} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />}
      <span className="hidden sm:inline-flex shrink-0"><StatusBadge status={issue.status} category={categoryToBadge[issue.category]} /></span>
      <span className="hidden md:inline-flex shrink-0"><PriorityBadge priority={issue.priority} /></span>
      <span
        className="ml-auto sm:ml-0 shrink-0 min-w-[1.75rem] text-center rounded-full bg-[var(--surface-3)] text-[var(--text-secondary)] text-[11px] font-medium px-1.5 py-0.5"
        aria-label={issue.storyPoints === null ? tr('No story point estimate') : tr('{points} story points', { points: formatPoints(issue.storyPoints) })}
        title={issue.storyPoints === null ? tr('No estimate') : tr('{points} story points', { points: formatPoints(issue.storyPoints) })}
      >
        {issue.storyPoints === null ? '–' : formatPoints(issue.storyPoints)}
      </span>
      <span className="shrink-0 w-7 flex justify-center">
        {issue.assignee ? (
          <Avatar name={issue.assignee.name} initials={issue.assignee.initials} size="sm" />
        ) : (
          <span className="w-5 h-5 rounded-full border border-dashed border-[var(--surface-4)]" title={tr('Unassigned')} aria-label={tr('Unassigned')} />
        )}
      </span>
      <MoveMenu
        label={`Move ${issue.key} to…`}
        options={moveOptions}
        onSelect={(t) => onMove(issue.key, t)}
        className="shrink-0 opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  )
})
