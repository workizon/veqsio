import { Bot } from 'lucide-react'

/** Marks an AI agent service account next to its name (assignee pickers, mentions, comments, activity). */
export function AgentBadge({ className = '' }: { className?: string }) {
  return (
    <span
      title="AI agent"
      className={`inline-flex items-center gap-0.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-500)] ${className}`}
    >
      <Bot className="w-3 h-3" aria-hidden="true" />
      <span>Agent</span>
    </span>
  )
}
