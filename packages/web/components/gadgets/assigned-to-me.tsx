'use client'

import Link from 'next/link'

import { useMyIssues } from '@/hooks/use-dashboards'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { format } from 'date-fns'
import { Clock, AlertCircle } from 'lucide-react'

interface AssignedToMeGadgetProps {
  config?: Record<string, unknown>
}

export function AssignedToMeGadget({ config }: AssignedToMeGadgetProps) {
  const { data, isLoading } = useMyIssues()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    )
  }

  if (!data?.length) {
    return (
      <EmptyState
        icon="inbox"
        title="No open issues"
        description="You have no issues assigned to you."
      />
    )
  }

  return (
    <div className="space-y-2">
      {data.map((issue) => (
        <Link
          href={`/issues/${issue.key}`}
          key={issue.id}
          className="block rounded-lg border border-[var(--surface-3)] p-3 hover:bg-[var(--surface-1)] transition-colors"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-caption text-[var(--text-tertiary)]">{issue.key}</span>
                <StatusBadge status={issue.status} />
              </div>
              <p className="text-body-sm text-[var(--text-primary)] truncate">
                {issue.summary}
              </p>
            </div>
            <PriorityBadge priority={issue.priority} />
          </div>
          {issue.dueDate && (
            <div className="flex items-center gap-1.5 mt-2 text-caption-sm text-[var(--warning)]">
              {new Date(issue.dueDate) < new Date() ? (
                <AlertCircle className="w-3.5 h-3.5" />
              ) : (
                <Clock className="w-3.5 h-3.5" />
              )}
              <span>
                {new Date(issue.dueDate) < new Date() ? 'Overdue: ' : 'Due: '}
                {format(new Date(issue.dueDate), 'MMM d')}
              </span>
            </div>
          )}
        </Link>
      ))}
    </div>
  )
}
