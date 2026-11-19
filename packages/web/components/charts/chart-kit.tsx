'use client'

import type { ReactNode } from 'react'

/**
 * Shared look for every chart (Recharts underneath): hairline horizontal grid only, quiet axes, gradient fills,
 * one tooltip and one legend style. Colours are design tokens, so light and dark themes both work, and every
 * series is also identified by name in the tooltip and legend (colour is never the only signal).
 */

export const SERIES = {
  brand: 'var(--brand-500)',
  green: '#14A38B',
  amber: '#F0A020',
  red: '#E5484D',
  violet: '#8B6CE0',
  sky: '#38A6D9',
  slate: '#667085',
} as const

/** Categorical palette for pies and stacked series. */
export const PALETTE = [SERIES.brand, SERIES.green, SERIES.amber, SERIES.red, SERIES.violet, SERIES.sky, '#EA7B2C', SERIES.slate]

export const axisTick = { fontSize: 11, fill: 'var(--text-tertiary)' } as const
export const gridProps = { stroke: 'var(--surface-3)', strokeDasharray: '2 4', vertical: false } as const
export const cursorStyle = { stroke: 'var(--surface-4)', strokeWidth: 1, strokeDasharray: '3 3' } as const

/** <defs> for a vertical fade used as an area fill. Reference it as fill={`url(#${id})`}. */
export function FadeGradient({ id, color, from = 0.28, to = 0 }: { id: string; color: string; from?: number; to?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={from} />
      <stop offset="100%" stopColor={color} stopOpacity={to} />
    </linearGradient>
  )
}

interface TooltipPayload { name?: string; value?: number | string; color?: string; dataKey?: string }

export function ChartTooltip({
  active, payload, label, formatLabel, formatValue,
}: {
  active?: boolean
  payload?: TooltipPayload[]
  label?: string | number
  formatLabel?: (l: string | number) => string
  formatValue?: (v: number | string, name?: string) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-[132px] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] px-3 py-2 shadow-[var(--shadow-lg)]">
      {label !== undefined && <div className="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">{formatLabel ? formatLabel(label) : label}</div>}
      <ul className="space-y-1">
        {payload.map((p) => (
          <li key={p.dataKey ?? p.name} className="flex items-center gap-2 text-[12px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden="true" />
            <span className="text-[var(--text-secondary)]">{p.name}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums text-[var(--text-primary)]">
              {p.value === undefined ? '' : formatValue ? formatValue(p.value, p.name) : p.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LegendPills({ items }: { items: Array<{ name: string; color: string; value?: ReactNode }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--text-secondary)]">
      {items.map((i) => (
        <li key={i.name} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} aria-hidden="true" />
          {i.name}
          {i.value !== undefined && <span className="font-semibold tabular-nums text-[var(--text-primary)]">{i.value}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Big number with a caption, shown above a chart so the headline is readable without hovering. */
export function Kpi({ value, caption, tone }: { value: ReactNode; caption: string; tone?: string }) {
  return (
    <div>
      <div className="text-[26px] leading-8 font-semibold tracking-tight tabular-nums" style={{ color: tone ?? 'var(--text-primary)' }}>{value}</div>
      <div className="text-[12px] text-[var(--text-tertiary)]">{caption}</div>
    </div>
  )
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="animate-pulse" style={{ height }} aria-hidden="true">
      <div className="h-6 w-24 rounded bg-[var(--surface-2)]" />
      <div className="mt-4 h-[calc(100%-2.5rem)] rounded-lg bg-[var(--surface-2)]" />
    </div>
  )
}

/** Short x-axis labels: 2026-11-10 -> 11-10; anything else is passed through. */
export const shortDate = (v: string | number) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : String(v))
