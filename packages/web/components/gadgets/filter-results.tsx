'use client'

import Link from 'next/link'

import { useFilterResults } from '@/hooks/use-dashboards'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { formatDistanceToNow } from 'date-fns'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface FilterResultsGadgetProps {
  config: { filterId?: string; jql?: string }
}

export function FilterResultsGadget({ config }: FilterResultsGadgetProps) {
  const ms = useMultiSort()
  const filterId = config.filterId || ''
  const jql = config.jql || ''
  const { data, isLoading } = useFilterResults(filterId || undefined, jql || undefined)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    )
  }

  if (!data?.length) {
    return <EmptyState icon="search" title="No issues found" description="Try adjusting your filter criteria." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--surface-3)]">
            <SortableTh {...ms.th('key')} className="veqsio-table-header">Key</SortableTh>
            <SortableTh {...ms.th('name')} className="veqsio-table-header">Summary</SortableTh>
            <SortableTh {...ms.th('status')} className="veqsio-table-header">Status</SortableTh>
            <SortableTh {...ms.th('priority')} className="veqsio-table-header">Priority</SortableTh>
            <SortableTh {...ms.th('assignee')} className="veqsio-table-header">Assignee</SortableTh>
            <SortableTh {...ms.th('updated')} className="veqsio-table-header">Updated</SortableTh>
          </tr>
        </thead>
        <tbody>
          {ms.sort(data, { key: (i) => i.key, name: (i) => i.summary, status: (i) => String(i.status), priority: (i) => String(i.priority), assignee: (i) => i.assignee, updated: (i) => new Date(i.updated) }).map((issue) => (
            <tr
              key={issue.id}
              className="border-b border-[var(--surface-3)] hover:bg-[var(--surface-1)] transition-colors"
            >
              <td className="py-2 px-4 text-caption text-[var(--text-tertiary)] whitespace-nowrap">
                <Link href={`/issues/${issue.key}`} className="text-[var(--brand-600)] hover:underline">{issue.key}</Link>
              </td>
              <td className="py-2 px-4 text-body-sm text-[var(--text-primary)] max-w-xs truncate">
                {issue.summary}
              </td>
              <td className="py-2 px-4">
                <StatusBadge status={issue.status} />
              </td>
              <td className="py-2 px-4">
                <PriorityBadge priority={issue.priority} />
              </td>
              <td className="py-2 px-4 text-caption text-[var(--text-secondary)]">
                {issue.assignee || 'Unassigned'}
              </td>
              <td className="py-2 px-4 text-caption text-[var(--text-tertiary)] whitespace-nowrap">
                {formatDistanceToNow(new Date(issue.updated), { addSuffix: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
