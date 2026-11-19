'use client'

import Link from 'next/link'
import { Bug, GitBranch, BookOpen, Layers, CheckCircle2 } from 'lucide-react'

const typeIcons: Record<string, typeof Bug> = {
  bug: Bug,
  task: CheckCircle2,
  story: BookOpen,
  epic: Layers,
  'sub-task': GitBranch,
}

interface IssueCardProps {
  id: number
  issueKey: string
  summary: string
  type?: 'bug' | 'task' | 'story' | 'epic' | 'sub-task'
  status?: string
  priority?: string
  assignee?: { name: string; initials: string }
  labels?: string[]
}

export function IssueCard({
  issueKey,
  summary,
  type = 'task',
  status = 'Open',
  priority = 'Medium',
  assignee,
  labels = [],
}: IssueCardProps) {
  const Icon = typeIcons[type] || Bug

  const statusColors: Record<string, string> = {
    'Open': 'veqsio-badge-status-todo',
    'To Do': 'veqsio-badge-status-todo',
    'In Progress': 'veqsio-badge-status-inprogress',
    'Resolved': 'veqsio-badge-status-done',
    'Closed': 'veqsio-badge-status-done',
    'Reopened': 'veqsio-badge-status-todo',
  }

  const priorityColors: Record<string, string> = {
    'Highest': 'bg-[var(--error)]/10 text-[var(--error)]',
    'High': 'bg-[var(--error)]/10 text-[var(--error)]',
    'Medium': 'bg-[var(--warning)]/10 text-[var(--warning)]',
    'Low': 'bg-[var(--success)]/10 text-[var(--success)]',
    'Lowest': 'bg-[var(--success)]/10 text-[var(--success)]',
  }

  return (
    <Link href={`/issues/${issueKey}`} className="block">
      <div className="veqsio-card group cursor-grab active:cursor-grabbing">
        {/* Top row: key + type icon */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-[var(--text-tertiary)]" />
            <span className="text-caption text-[var(--text-tertiary)]">{issueKey}</span>
          </div>
          {priority && (
            <span className={`veqsio-badge ${priorityColors[priority] || priorityColors['Medium']}`}>
              {priority}
            </span>
          )}
        </div>

        {/* Summary */}
        <p className="text-body-sm text-[var(--text-primary)] line-clamp-2 mb-3">
          {summary}
        </p>

        {/* Labels */}
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {labels.map((label) => (
              <span
                key={label}
                className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-secondary)]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Bottom row: status + avatar */}
        <div className="flex items-center justify-between">
          <span className={`veqsio-badge ${statusColors[status] || 'veqsio-badge-status-todo'}`}>
            {status}
          </span>

          {assignee ? (
            <div
              className="w-6 h-6 rounded-full bg-[var(--brand-500)] flex items-center justify-center"
              title={assignee.name}
            >
              <span className="text-white text-[10px] font-medium">{assignee.initials}</span>
            </div>
          ) : (
            <div className="w-6 h-6 rounded-full border-2 border-dashed border-[var(--surface-3)]" />
          )}
        </div>
      </div>
    </Link>
  )
}
