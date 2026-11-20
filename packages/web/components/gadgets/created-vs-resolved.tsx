'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useMemo } from 'react'
import { useCreatedVsResolved } from '@/hooks/use-dashboards'
import { EmptyState } from '@/components/empty-state'
import { BarTrend } from '@/components/charts/bar-trend'
import { ChartSkeleton, Kpi, LegendPills, SERIES } from '@/components/charts/chart-kit'

interface CreatedVsResolvedGadgetProps {
  config: { days?: number; period?: 'daily' | 'weekly' | 'monthly' }
}

/** Sums the per-day counts into weeks (7 days from the start of the range) or calendar months; labelled with the first day of each bucket. */
export function bucketByPeriod<T extends { date: string; created: number; resolved: number }>(days: T[], period: 'daily' | 'weekly' | 'monthly'): Array<{ date: string; created: number; resolved: number }> {
  if (period === 'daily') return days
  const out: Array<{ date: string; created: number; resolved: number }> = []
  days.forEach((d, i) => {
    const startNew = period === 'weekly' ? i % 7 === 0 : out.length === 0 || d.date.slice(0, 2) !== out[out.length - 1].date.slice(0, 2)
    if (startNew) out.push({ date: d.date, created: 0, resolved: 0 })
    const b = out[out.length - 1]
    b.created += d.created
    b.resolved += d.resolved
  })
  return out
}

export function CreatedVsResolvedGadget({ config }: CreatedVsResolvedGadgetProps) {
  const { tr } = useI18n();

  const days = config.days || 30
  const { data, isLoading } = useCreatedVsResolved(days)
  // a long range as one bar per day is hair-thin: show weeks (or months when asked), days only for a short range
  const period = config.period ?? (days > 45 ? 'weekly' : 'daily')
  const chartData = useMemo(() => bucketByPeriod(data || [], period), [data, period])
  const totals = useMemo(() => chartData.reduce((a, d) => ({ created: a.created + d.created, resolved: a.resolved + d.resolved }), { created: 0, resolved: 0 }), [chartData])

  if (isLoading) return <ChartSkeleton />
  if (!chartData.length) return <EmptyState icon="inbox" title={tr('No data available')} />

  const net = totals.created - totals.resolved
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Kpi
          value={`${net > 0 ? '+' : ''}${net}`}
          caption={`Net change over ${days} days (${net > 0 ? 'backlog growing' : net < 0 ? 'backlog shrinking' : 'balanced'})`}
          tone={net > 0 ? 'var(--warning)' : net < 0 ? 'var(--success)' : undefined}
        />
        <LegendPills items={[
          { name: 'Created', color: SERIES.brand, value: totals.created },
          { name: 'Resolved', color: SERIES.green, value: totals.resolved },
        ]} />
      </div>
      <BarTrend
        data={chartData as never} xKey="date"
        series={[{ key: 'created', name: 'Created', color: SERIES.brand }, { key: 'resolved', name: 'Resolved', color: SERIES.green }]}
        formatValue={(v) => `${v}`}
        trendOf={period === 'daily' ? 'created' : undefined}
      />
      {period === 'daily' && <p className="text-caption text-[var(--text-tertiary)]">{tr('Dashed line: 7-day average of created issues.')}</p>}
      {period !== 'daily' && <p className="text-caption text-[var(--text-tertiary)]">{tr('One bar per')} {period === 'weekly' ? 'week' : 'month'}{tr(', labelled with its first day.')}</p>}
    </div>
  )
}
