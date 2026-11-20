'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDroppable } from '@dnd-kit/core'
import { Plus } from 'lucide-react'

interface BoardColumnProps {
  id: string
  name: string
  count: number
  children: React.ReactNode
}

export function BoardColumn({ id, name, count, children }: BoardColumnProps) {
  const { tr } = useI18n();

  const { setNodeRef: setDroppableRef } = useDroppable({ id })
  const {
    setNodeRef: setSortableRef,
    transform,
    transition,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={(node) => {
        setDroppableRef(node)
        setSortableRef(node)
      }}
      style={style}
      className="flex-1 basis-72 min-w-[18rem] bg-[var(--surface-1)] rounded-lg border border-[var(--surface-3)] flex flex-col max-h-full"
    >
      {/* Column header */}
      <div className="p-3 border-b border-[var(--surface-3)] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="text-heading-3 text-[var(--text-primary)]">{name}</h3>
          <span className="text-caption text-[var(--text-tertiary)] bg-[var(--surface-2)] px-2 py-0.5 rounded-full">
            {count}
          </span>
        </div>
        <button className="veqsio-btn-ghost p-1" title={tr('Add issue')}>
          <Plus className="w-4 h-4 text-[var(--text-tertiary)]" />
        </button>
      </div>

      {/* Cards area */}
      <div className="p-2 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}
