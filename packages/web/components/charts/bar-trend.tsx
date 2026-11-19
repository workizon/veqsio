'use client'

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisTick, ChartTooltip, gridProps, shortDate } from './chart-kit'
import type { TrendSeries } from './area-trend'

/** Grouped rounded bars for discrete counts per day (a smoothed curve would invent values between whole numbers). */
/** Trailing moving average of `key` over `window` points (shorter at the start); rounded to one decimal. */
export function movingAverage(data: Array<Record<string, string | number>>, key: string, window: number): number[] {
  return data.map((_, i) => {
    const from = Math.max(0, i - window + 1)
    const slice = data.slice(from, i + 1)
    return Math.round((slice.reduce((a, d) => a + Number(d[key] ?? 0), 0) / slice.length) * 10) / 10
  })
}

export function BarTrend({
  data, xKey, series, height = 220, formatValue, trendOf, trendWindow = 7, trendColor = 'var(--text-secondary)',
}: {
  /** Draw a moving-average line of this series on top of the bars */
  trendOf?: string
  trendWindow?: number
  trendColor?: string
  data: Array<Record<string, string | number>>
  xKey: string
  series: TrendSeries[]
  height?: number
  formatValue?: (v: number | string, name?: string) => string
}) {
  const shown = trendOf ? data.map((d, i) => ({ ...d, trend: movingAverage(data, trendOf, trendWindow)[i] })) : data
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={shown} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} tickFormatter={shortDate} tick={axisTick} axisLine={false} tickLine={false} minTickGap={24} tickMargin={8} />
          <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
          <Tooltip cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }} content={<ChartTooltip formatValue={formatValue ?? ((v) => `${v}`)} />} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={10} />
          ))}
          {trendOf && <Line type="monotone" dataKey="trend" name={`${trendWindow}-day average`} stroke={trendColor} strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={{ r: 3 }} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
