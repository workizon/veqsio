'use client'

import { useMemo } from 'react'
import { useSprintHealth } from '@/hooks/use-dashboards'
import { AreaTrend } from '@/components/charts/area-trend'
import { ChartSkeleton, SERIES } from '@/components/charts/chart-kit'
import { EmptyState } from '@/components/empty-state'
import { CheckCircle2, AlertTriangle, TrendingUp } from 'lucide-react'

interface SprintHealthGadgetProps {
  config: { sprintId?: string }
}

export function SprintHealthGadget({ config }: SprintHealthGadgetProps) {
  const sprintId = config.sprintId || '1'
  const { data, isLoading } = useSprintHealth(sprintId)

  const chartData = useMemo(() => data || [], [data])

  const latest = chartData[chartData.length - 1]
  const total = latest?.total || 0
  const completed = latest?.completed || 0
  const remaining = latest?.remaining || 0
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

  if (isLoading) {
    return <ChartSkeleton />
  }

  if (!chartData.length) {
    return <EmptyState icon="inbox" title="No sprint data available" />
  }

  return (
    <div className="space-y-4">
      {/* Sprint stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[var(--surface-1)] rounded-lg p-3 border border-[var(--surface-3)]">
          <div className="flex items-center gap-2 text-[var(--success)] mb-1">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-caption-sm font-medium">Completed</span>
          </div>
          <p className="text-heading-2 text-[var(--text-primary)]">{completed}</p>
        </div>
        <div className="bg-[var(--surface-1)] rounded-lg p-3 border border-[var(--surface-3)]">
          <div className="flex items-center gap-2 text-[var(--warning)] mb-1">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-caption-sm font-medium">Remaining</span>
          </div>
          <p className="text-heading-2 text-[var(--text-primary)]">{remaining}</p>
        </div>
        <div className="bg-[var(--surface-1)] rounded-lg p-3 border border-[var(--surface-3)]">
          <div className="flex items-center gap-2 text-[var(--brand-500)] mb-1">
            <TrendingUp className="w-4 h-4" />
            <span className="text-caption-sm font-medium">Progress</span>
          </div>
          <p className="text-heading-2 text-[var(--text-primary)]">{percent}%</p>
        </div>
      </div>

      {/* Burndown chart */}
      <AreaTrend
        data={chartData as never} xKey="name" height={200}
        series={[
          { key: 'ideal', name: 'Ideal', color: SERIES.slate },
          { key: 'remaining', name: 'Remaining', color: SERIES.brand },
          { key: 'completed', name: 'Completed', color: SERIES.green },
        ]}
        formatValue={(v) => `${v}`}
      />
    </div>
  )
}
