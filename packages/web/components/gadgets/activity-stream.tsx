'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useActivityStream } from '@/hooks/use-dashboards'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { formatDistanceToNow } from 'date-fns'
import { MessageSquare, GitCommit, UserPlus, CheckCircle2, Flag } from 'lucide-react'

interface ActivityStreamGadgetProps {
  config?: { limit?: number }
}

const actionIcons: Record<string, React.ReactNode> = {
  commented: <MessageSquare className="w-4 h-4" />,
  commented_on: <MessageSquare className="w-4 h-4" />,
  transitioned: <GitCommit className="w-4 h-4" />,
  created: <Flag className="w-4 h-4" />,
  assigned: <UserPlus className="w-4 h-4" />,
  resolved: <CheckCircle2 className="w-4 h-4" />,
}

export function ActivityStreamGadget({ config }: ActivityStreamGadgetProps) {
  const { tr } = useI18n();

  const limit = config?.limit || 10
  const { data, isLoading } = useActivityStream(limit)

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
        title={tr('No recent activity')}
        description={tr('Activity will appear here as team members make changes.')}
      />
    )
  }

  return (
    <div className="space-y-0">
      {data.map((item, index) => {
        const icon = actionIcons[item.action] || <GitCommit className="w-4 h-4" />
        const isLast = index === data.length - 1

        return (
          <div key={item.id} className="flex gap-3 relative">
            {!isLast && (
              <div className="absolute left-[18px] top-8 bottom-0 w-px bg-[var(--surface-3)]" />
            )}
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-[var(--surface-2)] flex items-center justify-center text-[var(--brand-500)]">
              {icon}
            </div>
            <div className="flex-1 min-w-0 pb-4">
              <p className="text-body-sm text-[var(--text-primary)]">
                <span className="font-medium">{tr(item.user)}</span>{' '}
                <span className="text-[var(--text-secondary)]">{tr(item.action)}</span>{' '}
                <Link href={`/issues/${item.issueKey}`} className="font-medium text-[var(--brand-600)] hover:underline">{item.issueKey}</Link>
              </p>
              <p className="text-caption text-[var(--text-secondary)] truncate">
                <Link href={`/issues/${item.issueKey}`} className="hover:text-[var(--text-primary)] hover:underline" title={item.issueSummary}>{item.issueSummary}</Link>
              </p>
              <p className="text-caption-sm text-[var(--text-tertiary)] mt-0.5">
                {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
