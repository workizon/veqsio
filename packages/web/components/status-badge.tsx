'use client'

interface StatusBadgeProps {
  status: string
  category?: 'backlog' | 'to_do' | 'in_progress' | 'done' | 'cancelled'
}

export function StatusBadge({ status, category }: StatusBadgeProps) {
  const categoryMap: Record<string, 'backlog' | 'to_do' | 'in_progress' | 'done' | 'cancelled'> = {
    'Backlog': 'backlog',
    'Cancelled': 'cancelled',
    'Canceled': 'cancelled',
    'Open': 'to_do',
    'To Do': 'to_do',
    'In Progress': 'in_progress',
    'Resolved': 'done',
    'Done': 'done',
    'Closed': 'done',
    'Reopened': 'to_do',
  }

  const cat = category || categoryMap[status] || 'to_do'

  const variants: Record<string, string> = {
    backlog: 'veqsio-badge-status-backlog',
    cancelled: 'veqsio-badge-status-cancelled',
    to_do: 'veqsio-badge-status-todo',
    in_progress: 'veqsio-badge-status-inprogress',
    done: 'veqsio-badge-status-done',
  }

  return (
    <span className={`veqsio-badge ${variants[cat]} inline-flex items-center gap-1.5 whitespace-nowrap`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80 shrink-0" aria-hidden="true" />
      {status}
    </span>
  )
}
