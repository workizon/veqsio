'use client'

import { useId } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisTick, ChartTooltip, cursorStyle, FadeGradient, gridProps, shortDate } from './chart-kit'

export interface TrendSeries { key: string; name: string; color: string; dashed?: boolean; /** no gradient fill, line only */ line?: boolean
  /** Step line (scope that jumps when work is added or removed) instead of a smooth curve. */
  stepped?: boolean
}

/** Vertical reference line at an x value (today, release date). */
export interface ChartMarker { x: string; label: string; color?: string }

/** Smooth gradient area chart for one or more series that share an x axis (a date or a label). */
export function AreaTrend({
  data, xKey, series, height = 220, unit = '', formatValue, stacked = false, markers = [],
}: {
  data: Array<Record<string, string | number>>
  xKey: string
  series: TrendSeries[]
  height?: number
  unit?: string
  formatValue?: (v: number | string, name?: string) => string
  /** Stack the series on top of each other (cumulative flow). */
  stacked?: boolean
  markers?: ChartMarker[]
}) {
  const uid = useId().replace(/:/g, '')
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>{series.map((s) => <FadeGradient key={s.key} id={`${uid}-${s.key}`} color={s.color} />)}</defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} tickFormatter={shortDate} tick={axisTick} axisLine={false} tickLine={false} minTickGap={24} tickMargin={8} />
          <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => `${v}${unit}`} allowDecimals={false} />
          <Tooltip cursor={cursorStyle} content={<ChartTooltip formatLabel={(l) => String(l)} formatValue={formatValue ?? ((v) => `${v}${unit}`)} />} />
          {markers.filter((m) => data.some((d) => d[xKey] === m.x)).map((m) => (
            <ReferenceLine key={m.label} x={m.x} stroke={m.color ?? 'var(--text-tertiary)'} strokeDasharray="3 3" label={{ value: m.label, position: 'insideTopRight', fontSize: 11, fill: 'var(--text-tertiary)' }} />
          ))}
          {series.map((s) => (
            <Area
              key={s.key} type={s.stepped ? 'stepAfter' : 'monotone'} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2}
              strokeDasharray={s.dashed ? '5 4' : undefined} connectNulls={false}
              stackId={stacked ? 'stack' : undefined}
              fill={s.line || s.dashed ? 'transparent' : `url(#${uid}-${s.key})`} fillOpacity={1}
              dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-0)', fill: s.color }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
