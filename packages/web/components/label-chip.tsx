'use client'

import { X } from 'lucide-react'
import { describeLabel, labelChipProps } from '@/lib/label-colors'
import type { LabelDetail } from '@/hooks/use-labels'
import { useLabels, labelColorMap } from '@/hooks/use-labels'
import { useMemo, type CSSProperties } from 'react'

/**
 * One coloured label chip. The name is always rendered as text; the dot and tint are extra information,
 * so the chip stays readable for colour-blind users and in high contrast modes.
 */
export function LabelChip({
  name,
  color,
  removeOnResolve = false,
  onRemove,
  className = '',
}: {
  name: string
  color?: string | null
  removeOnResolve?: boolean
  onRemove?: () => void
  className?: string
}) {
  const props = labelChipProps(color)
  return (
    <span
      className={`${props.className} ${className}`}
      style={props.style as CSSProperties | undefined}
      title={describeLabel(name, color, removeOnResolve)}
      data-label={name}
    >
      <span className="label-dot" aria-hidden="true" />
      <span className="truncate max-w-[12rem]">{name}</span>
      {removeOnResolve && <span className="sr-only"> (removed when the issue is resolved)</span>}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove label ${name}`}
          className="-mr-1 rounded-full p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

/**
 * A row of chips for an issue. Uses `details` (fields.labelDetails) when the API sent them; otherwise
 * falls back to the global label list so older payloads and cached lists still get colours.
 */
export function LabelChips({
  labels,
  details,
  max,
  className = '',
}: {
  labels: string[] | undefined
  details?: LabelDetail[]
  max?: number
  className?: string
}) {
  const { data } = useLabels(!details)
  const lookup = useMemo(() => (details ? new Map(details.map((d) => [d.name, d])) : labelColorMap(data?.labels)), [details, data])
  const list = labels ?? []
  if (list.length === 0) return null
  const shown = max ? list.slice(0, max) : list
  const hidden = list.length - shown.length
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {shown.map((n) => {
        const d = lookup.get(n)
        return <LabelChip key={n} name={n} color={d?.color} removeOnResolve={d?.removeOnResolve} />
      })}
      {hidden > 0 && <span className="text-xs text-[var(--text-tertiary)]" title={list.slice(max).join(', ')}>+{hidden}</span>}
    </span>
  )
}
