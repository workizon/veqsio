'use client'

import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { useTimeInStatusReport } from '@/hooks/use-issue-history'
import { barShares, categoryColor, categoryLabel, formatDuration } from '@/lib/time-in-status'

/** "Average time in status" for a board's project or one sprint: a bar per status and a table. */
export function TimeInStatusReportView({ boardId, sprintId }: { boardId?: string; sprintId?: string }) {
  const { data, isLoading, error } = useTimeInStatusReport(sprintId ? { sprintId } : { boardId })
  const ms = useMultiSort()
  if (isLoading) return <Spinner />
  if (error) return <p role="alert" className="text-[var(--error)]">{(error as Error).message}</p>
  if (!data || data.statuses.length === 0) return <EmptyState icon="history" title="Nothing to average yet" description="Issues need at least one status to be counted." />
  const bars = barShares(data.statuses.map((s) => ({ ...s, durationMs: s.avgMs })))
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        {data.scope.name}: {data.issueCount} issue{data.issueCount === 1 ? '' : 's'}. Average length of one stay in each status; open stays count until now.
        {data.truncated && ' Only the newest 5000 issues are included.'}
      </p>
      <div role="img" aria-label={`Average time per status: ${data.statuses.map((s) => `${s.status} ${formatDuration(s.avgMs)}`).join(', ')}`} className="flex h-4 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
        {bars.map((s) => <div key={s.status} title={`${s.status}: ${formatDuration(s.avgMs)}`} style={{ width: `${s.pct}%`, background: categoryColor(s.category) }} className="border-r border-[var(--surface-0)] last:border-r-0" />)}
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">Average time in status</caption>
        <thead><tr className="text-left text-[var(--text-tertiary)]"><SortableTh {...ms.th('status')}>Status</SortableTh><SortableTh {...ms.th('category')}>Category</SortableTh><SortableTh {...ms.th('issues')}>Issues</SortableTh><SortableTh {...ms.th('visits')}>Stays</SortableTh><SortableTh {...ms.th('avg')}>Average</SortableTh><SortableTh {...ms.th('total')}>Total</SortableTh></tr></thead>
        <tbody>
          {ms.sort(data.statuses, { status: (s) => s.status, category: (s) => categoryLabel(s.category), issues: (s) => s.issues, visits: (s) => s.visits, avg: (s) => s.avgMs, total: (s) => s.totalMs }).map((s) => (
            <tr key={s.status} className="border-t border-[var(--surface-2)]">
              <td className="py-1"><span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: categoryColor(s.category) }} />{s.status}</span></td>
              <td>{categoryLabel(s.category)}</td><td>{s.issues}</td><td>{s.visits}</td>
              <td className="font-medium">{formatDuration(s.avgMs)}</td><td>{formatDuration(s.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.categories.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]" aria-label="Average time per category and issue">
          {data.categories.map((c) => <li key={c.category}>{categoryLabel(c.category)}: <strong className="text-[var(--text-primary)]">{formatDuration(c.avgMs)}</strong> per issue</li>)}
        </ul>
      )}
    </div>
  )
}
