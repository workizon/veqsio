'use client'

import { Search, FolderOpen, Inbox, Frown, MessageSquare, History, Paperclip, Link as LinkIcon, Archive } from 'lucide-react'

interface EmptyStateProps {
  icon?: 'search' | 'folder' | 'inbox' | 'frown' | 'message' | 'history' | 'paperclip' | 'link' | 'archive' | React.ComponentType<{ className?: string }>
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}

const icons = {
  search: Search,
  folder: FolderOpen,
  inbox: Inbox,
  frown: Frown,
  message: MessageSquare,
  history: History,
  paperclip: Paperclip,
  link: LinkIcon,
  archive: Archive,
}

export function EmptyState({ icon = 'inbox', title, description, action }: EmptyStateProps) {
  const Icon = typeof icon === 'string' ? icons[icon] : icon

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-20 h-20 rounded-2xl bg-[var(--surface-2)] flex items-center justify-center mb-5">
        <Icon className="w-10 h-10 text-[var(--text-tertiary)]" />
      </div>
      <h3 className="text-heading-2 text-[var(--text-primary)] mb-2">{title}</h3>
      {description && (
        <p className="text-body-sm text-[var(--text-secondary)] mb-6 max-w-sm">
          {description}
        </p>
      )}
      {action && <div>{action}</div>}
    </div>
  )
}
