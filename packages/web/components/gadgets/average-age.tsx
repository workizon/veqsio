'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useMemo } from 'react'
import { useAverageAge, type GadgetPeriod } from '@/hooks/use-dashboards'
import { EmptyState } from '@/components/empty-state'
import { AreaTrend } from '@/components/charts/area-trend'
import { ChartSkeleton, Kpi, SERIES } from '@/components/charts/chart-kit'

interface Props {
  config: { period?: GadgetPeriod; count?: number }
}

export function AverageAgeGadget({ config }: Props) {
  const { tr } = useI18n();

  const { data, isLoading } = useAverageAge(config.period || 'daily', config.count || 30)

  const summary = useMemo(() => {
    if (!data?.length) return null
    const last = data[data.length - 1].averageDays
    const first = data.find((p) => p.averageDays > 0)?.averageDays ?? 0
    return { last, delta: first ? Math.round(((last - first) / first) * 100) : null }
  }, [data])

  if (isLoading) return <ChartSkeleton />
  if (!data || !data.some((p) => p.averageDays > 0)) return <EmptyState icon="inbox" title={tr('No data available')} />

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <Kpi value={<>{summary?.last.toFixed(1)}<span className="ml-0.5 text-[14px] font-medium text-[var(--text-tertiary)]">d</span></>} caption="Average age of open issues (days)" />
        {summary?.delta != null && (
          <span className="mb-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[12px] font-medium tabular-nums text-[var(--text-secondary)]" title={tr('Change since the first non-zero point')}>
            {summary.delta > 0 ? '+' : ''}{summary.delta}%
          </span>
        )}
      </div>
      <AreaTrend data={data as never} xKey="date" series={[{ key: 'averageDays', name: 'Average age (days)', color: SERIES.brand }]} unit="d" formatValue={(v) => `${Number(v).toFixed(1)} days`} />
    </div>
  )
}
