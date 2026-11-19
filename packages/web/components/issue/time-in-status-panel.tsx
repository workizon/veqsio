'use client'

import { Clock } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Spinner } from '@/components/spinner'
import { useTimeInStatus } from '@/hooks/use-issue-history'
import { barShares, categoryColor, categoryLabel, formatDuration } from '@/lib/time-in-status'

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** "Transitions" tab of the activity section: a bar of the time per stay and a table of every stay. */
export function TimeInStatusPanel({ issueKey }: { issueKey: string }) {
  const { data, isLoading, error } = useTimeInStatus(issueKey)

  if (isLoading) return <div className="flex justify-center py-6"><Spinner /></div>
  if (error) return <p role="alert" className="text-body-sm text-[var(--error)]">{(error as Error).message}</p>
  if (!data || data.segments.length === 0) {
    return <EmptyState icon={Clock} title="No transitions yet" description="The time the issue spends in each status will be listed here." />
  }
  const bar = barShares(data.segments.map((s, i) => ({ ...s, idx: i })))

  return (
    <div className="space-y-4">
      <div>
        <div
          role="img"
          aria-label={`Time in status: ${data.segments.map((s) => `${s.status} ${formatDuration(s.durationMs)}`).join(', ')}`}
          className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
        >
          {bar.map((s) => (
            <div
              key={s.idx}
              title={`${s.status}: ${formatDuration(s.durationMs)}`}
              style={{ width: `${s.pct}%`, background: categoryColor(s.category) }}
              className="border-r border-[var(--surface-0)] last:border-r-0"
            />
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-[var(--text-secondary)]" aria-label="Time per status category">
          {data.byCategory.map((c) => (
            <li key={c.category} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: categoryColor(c.category) }} />
              {categoryLabel(c.category)}: <span className="font-medium text-[var(--text-primary)]">{formatDuration(c.durationMs)}</span>
            </li>
          ))}
          <li>Total: <span className="font-medium text-[var(--text-primary)]">{formatDuration(data.totalMs)}</span></li>
        </ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <caption className="sr-only">Every stay of {issueKey} in a status</caption>
          <thead>
            <tr className="text-left text-caption text-[var(--text-tertiary)] border-b border-[var(--surface-3)]">
              <th scope="col" className="py-1.5 pr-3 font-medium">Status</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Entered</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Left</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Duration</th>
              <th scope="col" className="py-1.5 font-medium">Moved by</th>
            </tr>
          </thead>
          <tbody>
            {data.segments.map((s, i) => (
              <tr key={i} className="border-b border-[var(--surface-2)] last:border-0">
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5 text-[var(--text-primary)]">
                    <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: categoryColor(s.category) }} />
                    {s.status}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{fmt(s.enteredAt)}</td>
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{s.leftAt ? fmt(s.leftAt) : <span className="text-[var(--brand-500)]">current</span>}</td>
                <td className="py-1.5 pr-3 font-medium text-[var(--text-primary)]">{formatDuration(s.durationMs)}</td>
                <td className="py-1.5 text-[var(--text-secondary)]">{s.movedBy?.displayName ?? 'System'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
