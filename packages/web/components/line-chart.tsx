'use client'

import { AreaTrend } from '@/components/charts/area-trend'
import { LegendPills } from '@/components/charts/chart-kit'

export interface Series { name: string; color: string; values: Array<number | null>; dashed?: boolean }

/**
 * Report chart: labels on x, one or more series. Kept as a thin wrapper so report pages stay declarative; the look
 * comes from the shared chart kit. `stacked` is for cumulative-flow style charts.
 */
export function LineChart({ labels, series, height = 260, ariaLabel, stacked = false }: {
  labels: string[]; series: Series[]; height?: number; ariaLabel: string; stacked?: boolean
}) {
  const data = labels.map((label, i) => {
    const row: Record<string, string | number> = { label }
    series.forEach((s, j) => { const v = s.values[i]; if (v !== null && v !== undefined && Number.isFinite(v)) row[`s${j}`] = v })
    return row
  })
  return (
    <figure role="img" aria-label={ariaLabel} className="space-y-2">
      <LegendPills items={series.map((s) => ({ name: s.name, color: s.color }))} />
      <AreaTrend
        data={data} xKey="label" height={height} stacked={stacked}
        series={series.map((s, j) => ({ key: `s${j}`, name: s.name, color: s.color, dashed: s.dashed, line: !stacked && series.length > 2 }))}
      />
    </figure>
  )
}
