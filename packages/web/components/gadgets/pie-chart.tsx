'use client'

import { useMemo } from 'react'
import { useGadgetData, useIssueDistribution } from '@/hooks/use-dashboards'
import { ChartSkeleton } from '@/components/charts/chart-kit'
import { Donut } from '@/components/charts/donut'
import { EmptyState } from '@/components/empty-state'

interface PieChartGadgetProps {
  config: { field?: string; jql?: string; filterId?: string; limit?: number; sort?: string }
}

export function PieChartGadget({ config }: PieChartGadgetProps) {
  const field = config.field || 'status'
  const filtered = !!(config.jql || config.filterId)
  const all = useIssueDistribution(field)
  // With a JQL or a saved filter the distribution is computed over just those issues.
  const scoped = useGadgetData<{ buckets: { name: string; value: number }[] }>('issue-statistics', { field, jql: config.jql, filterId: config.filterId, limit: config.limit, sort: config.sort })
  const isLoading = filtered ? scoped.isLoading : all.isLoading
  const data = filtered ? scoped.data?.buckets : all.data

  const chartData = useMemo(() => data || [], [data])

  if (isLoading) return <ChartSkeleton />
  if (!chartData.length) return <EmptyState icon="inbox" title="No data available" />

  return <Donut data={chartData.map((d) => ({ name: String(d.name), value: Number(d.value) }))} label={field === 'status' ? 'Issues' : 'Issues'} />
}
