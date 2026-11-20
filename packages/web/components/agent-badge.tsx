'use client'

import { Bot } from 'lucide-react'
import { useI18n } from '@/hooks/use-i18n'

/** Marks an AI agent service account next to its name (assignee pickers, mentions, comments, activity). */
export function AgentBadge({ className = '' }: { className?: string }) {
  const { tr } = useI18n()
  return (
    <span
      title={tr('AI agent')}
      className={`inline-flex items-center gap-0.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-500)] ${className}`}
    >
      <Bot className="w-3 h-3" aria-hidden="true" />
      <span>{tr('Agent')}</span>
    </span>
  )
}
