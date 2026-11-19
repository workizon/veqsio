'use client'

import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type Announcements,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, Copy, EyeOff, GitBranch, GripVertical, Trash2 } from 'lucide-react'
import { typeLabel, MAPPING_LABELS } from '@/lib/form-builder'
import { isLayout, type FieldDef } from '@/lib/request-form'

export interface CanvasProps {
  fields: FieldDef[]
  selected: number | null
  problems: Map<number, string[]>
  readOnly?: boolean
  onSelect: (index: number) => void
  onMove: (from: number, to: number) => void
  onDuplicate: (index: number) => void
  onRemove: (index: number) => void
}

const idOf = (i: number) => `field-${i}`
const indexOf = (id: string | number) => Number(String(id).replace('field-', ''))

/**
 * The form canvas: fields in order. Reordering works by drag (pointer or keyboard through the handle:
 * Space to lift, arrow keys to move, Space to drop) and by the explicit up/down buttons.
 */
export function FormCanvas({ fields, selected, problems, readOnly, onSelect, onMove, onDuplicate, onRemove }: CanvasProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const label = (id: string | number) => fields[indexOf(id)]?.label || 'field'
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}. Use the arrow keys to move it, Space to drop.`,
    onDragOver: ({ active, over }) => (over ? `${label(active.id)} is now at position ${indexOf(over.id) + 1} of ${fields.length}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${label(active.id)} at position ${indexOf(over.id) + 1} of ${fields.length}.` : `${label(active.id)} was dropped.`),
    onDragCancel: ({ active }) => `Moving ${label(active.id)} was cancelled.`,
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    onMove(indexOf(e.active.id), indexOf(e.over.id))
  }

  if (fields.length === 0) {
    return (
      <div className="rounded-lg border-2 border-dashed border-[var(--surface-4)] p-10 text-center text-sm text-[var(--text-tertiary)]">
        This form has no fields yet. {readOnly ? '' : 'Pick a field type on the right to add it.'}
      </div>
    )
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
      <SortableContext items={fields.map((_, i) => idOf(i))} strategy={verticalListSortingStrategy}>
        <ul className="space-y-2" aria-label="Form fields">
          {fields.map((f, i) => (
            <CanvasItem
              key={idOf(i)} id={idOf(i)} field={f} index={i} total={fields.length} selected={selected === i}
              problems={problems.get(i)} readOnly={readOnly}
              onSelect={() => onSelect(i)} onMove={onMove} onDuplicate={() => onDuplicate(i)} onRemove={() => onRemove(i)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

interface ItemProps {
  id: string; field: FieldDef; index: number; total: number; selected: boolean; problems?: string[]; readOnly?: boolean
  onSelect: () => void; onMove: (from: number, to: number) => void; onDuplicate: () => void; onRemove: () => void
}

function CanvasItem({ id, field, index, total, selected, problems, readOnly, onSelect, onMove, onDuplicate, onRemove }: ItemProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const layout = isLayout(field.type)
  const name = field.label || field.key
  return (
    <li
      ref={setNodeRef} style={style}
      className={`rounded-lg border bg-[var(--surface-0)] ${selected ? 'border-[var(--brand-500)] ring-1 ring-[var(--brand-500)]' : 'border-[var(--surface-3)]'} ${isDragging ? 'opacity-70 shadow-lg z-10 relative' : ''} ${field.internal ? 'border-dashed' : ''}`}
    >
      <div className="flex items-stretch">
        {!readOnly && (
          <button
            ref={setActivatorNodeRef} type="button" {...attributes} {...listeners}
            aria-label={`Reorder ${name}. Press Space to pick up, arrow keys to move.`}
            className="px-2 cursor-grab text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-l-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)]"
          >
            <GripVertical className="w-4 h-4" aria-hidden />
          </button>
        )}
        <button
          type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Edit ${name}`}
          className="flex-1 min-w-0 text-left p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)] rounded-lg"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`truncate ${layout ? 'font-semibold' : 'font-medium'} text-[var(--text-primary)]`}>{name}</span>
            {field.required && <span className="text-[var(--error)]" aria-label="required">*</span>}
            <span className="text-xs text-[var(--text-tertiary)]">{typeLabel(field.type)}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            {field.internal && <Badge icon={<EyeOff className="w-3 h-3" aria-hidden />}>Internal only</Badge>}
            {field.visibleWhen && <Badge icon={<GitBranch className="w-3 h-3" aria-hidden />}>Conditional</Badge>}
            {field.mapping && field.mapping.target !== 'none' && <Badge>{`→ ${MAPPING_LABELS[field.mapping.target]}`}</Badge>}
            {field.mapping?.target === 'none' && <Badge>Form only</Badge>}
            {problems?.length ? <span className="rounded px-1.5 py-0.5 bg-[var(--error)]/10 text-[var(--error)]" role="status">{problems.length} problem{problems.length === 1 ? '' : 's'}</span> : null}
          </div>
        </button>
        {!readOnly && (
          <div className="flex items-center pr-1">
            <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(index, index - 1)}><ArrowUp className="w-4 h-4" /></button>
            <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move ${name} down`} disabled={index === total - 1} onClick={() => onMove(index, index + 1)}><ArrowDown className="w-4 h-4" /></button>
            <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Duplicate ${name}`} onClick={onDuplicate}><Copy className="w-4 h-4" /></button>
            <button type="button" className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Delete ${name}`} onClick={onRemove}><Trash2 className="w-4 h-4" /></button>
          </div>
        )}
      </div>
    </li>
  )
}

function Badge({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-[var(--surface-2)] text-[var(--text-secondary)]">{icon}{children}</span>
}
