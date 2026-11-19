'use client'

import Link from 'next/link'
import { Check } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { ComponentProps } from 'react'
import { BoardCard, type BoardCardIssue } from '@/components/board-card'
import { SwipeCard, type SwipeAction } from '@/components/swipe-card'

/**
 * A board card that can be dragged to another column (pointer drag; the card stays a normal link, so a click still
 * opens the issue) and selected for the command line with the checkbox button (keyboard accessible, also Shift/Ctrl-click).
 */
export function DraggableBoardCard({ issue, selected, onToggleSelect, cardProps, swipe }: {
  /** Touch swipe actions (move to the next or previous column) */
  swipe?: { left?: SwipeAction; right?: SwipeAction }; issue: BoardCardIssue & { id: number | string }; selected: boolean; onToggleSelect: (key: string) => void; /** colour and flag props of the card (card colours, flag toggle) */ cardProps?: Omit<ComponentProps<typeof BoardCard>, 'issue'> }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: issue.key })
  return (
    <div
      ref={setNodeRef}
      data-board-card={issue.key}
      className={`relative group/card transition-opacity ${isDragging ? 'opacity-40' : ''} ${selected ? 'rounded-lg ring-2 ring-[var(--brand-500)]' : ''}`}
      {...listeners}
    >
      <SwipeCard left={swipe?.left} right={swipe?.right}>
        <Link
          href={`/issues/${issue.key}`}
          draggable={false}
          className="block no-underline"
          onClick={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); onToggleSelect(issue.key) } }}
        >
          <BoardCard issue={issue} {...cardProps} />
        </Link>
      </SwipeCard>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${issue.key}`}
        onClick={() => onToggleSelect(issue.key)}
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute top-1.5 right-1.5 w-5 h-5 rounded border flex items-center justify-center bg-[var(--surface-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-opacity ${selected ? 'opacity-100 border-[var(--brand-500)] bg-[var(--brand-500)] text-white' : 'opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 border-[var(--surface-4)]'}`}
      >
        {selected && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
      </button>
    </div>
  )
}

/** Column body that accepts dropped cards; highlights while a card is over it. */
export function DroppableColumn({ columnId, children, className = '' }: { columnId: number | string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${columnId}` })
  return (
    <div ref={setNodeRef} className={`${className} transition-colors ${isOver ? 'bg-[var(--brand-50)] outline outline-2 outline-dashed outline-[var(--brand-500)] -outline-offset-2' : ''}`}>
      {children}
    </div>
  )
}
