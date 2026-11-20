'use client'

import { useI18n } from '@/hooks/use-i18n'

interface PriorityBadgeProps {
  priority: string
  /** Hide the text and keep the icon (the name stays available as a tooltip and to screen readers). */
  iconOnly?: boolean
  className?: string
}

/** bars = how many of the three bars are filled; colour comes from design tokens so both themes work. */
const LEVELS: Record<string, { bars: number; color: string }> = {
  highest: { bars: 3, color: 'var(--error)' },
  high: { bars: 3, color: '#EA7B2C' },
  medium: { bars: 2, color: 'var(--warning)' },
  low: { bars: 1, color: 'var(--brand-500)' },
  lowest: { bars: 1, color: 'var(--text-tertiary)' },
}

export function PriorityIcon({ priority, size = 14 }: { priority: string; size?: number }) {
  const level = LEVELS[priority.toLowerCase()] ?? LEVELS.medium
  const urgent = priority.toLowerCase() === 'highest'
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      {urgent ? (
        <>
          <rect x="0.5" y="0.5" width="13" height="13" rx="3.5" fill={level.color} />
          <rect x="6.1" y="3" width="1.8" height="5" rx="0.9" fill="#fff" />
          <rect x="6.1" y="9.3" width="1.8" height="1.8" rx="0.9" fill="#fff" />
        </>
      ) : (
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={1.5 + i * 4}
            y={9 - i * 3.5}
            width="3"
            height={4 + i * 3.5}
            rx="1"
            fill={i < level.bars ? level.color : 'var(--surface-4)'}
          />
        ))
      )}
    </svg>
  )
}

export function PriorityBadge({ priority, iconOnly = false, className = '' }: PriorityBadgeProps) {
  const { tr } = useI18n()
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] leading-5 text-[var(--text-secondary)] whitespace-nowrap ${className}`}
      title={tr('Priority: {name}', { name: priority })}
    >
      <PriorityIcon priority={priority} />
      {iconOnly ? <span className="sr-only">{priority}</span> : <span>{priority}</span>}
    </span>
  )
}
