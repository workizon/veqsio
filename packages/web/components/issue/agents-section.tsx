'use client'


import { useI18n } from '@/hooks/use-i18n'
import { Bot } from 'lucide-react'
import { toast } from '@/components/toast'
import { RelativeTime } from './primitives'
import { ACTIVE_RUN, TRIGGER_LABELS, useIssueAgentRuns, useStopRun } from '@/hooks/use-agents'
import { useFeatures } from '@/hooks/use-features'

const STATUS_STYLE: Record<string, string> = {
  queued: 'text-[var(--text-secondary)]', delivered: 'text-[var(--brand-500)]', running: 'text-[var(--brand-500)]',
  succeeded: 'text-[var(--success)]', failed: 'text-[var(--error)]', cancelled: 'text-[var(--text-tertiary)]',
}

/** "Agents" section of the issue view: run log of AI agents on this issue with a Stop button for active runs. Hidden when there is nothing to show. */
export function AgentsSection({ issueKey }: { issueKey: string }) {
  const { tr } = useI18n();

  const { isEnabled } = useFeatures()
  const on = isEnabled('agents')
  const runs = useIssueAgentRuns(issueKey, on)
  const stop = useStopRun(issueKey)
  if (!on || runs.isLoading || runs.error || !runs.data || runs.data.length === 0) return null

  return (
    <section aria-labelledby="agents-heading" className="space-y-3">
      <h2 id="agents-heading" className="text-heading-3 text-[var(--text-primary)] flex items-center gap-2"><Bot className="w-5 h-5" aria-hidden="true" />{tr('Agents')}</h2>
      <ul className="space-y-2">
        {runs.data.map((r) => {
          const active = ACTIVE_RUN.includes(r.status)
          return (
            <li key={r.id} className="veqsio-card p-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong>{r.agent?.displayName ?? 'Agent'}</strong>
              <span className={`text-sm font-medium ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
              <span className="text-xs text-[var(--text-tertiary)]">{TRIGGER_LABELS[r.trigger] ?? r.trigger}</span>
              <RelativeTime date={r.createdAt} className="text-xs text-[var(--text-tertiary)]" />
              {active && (
                <button type="button" className="ml-auto veqsio-btn-secondary text-sm" disabled={stop.isPending}
                  onClick={() => stop.mutate(r.id, { onError: (e) => toast(e.message, 'error') })}>{tr('Stop')}</button>
              )}
              {r.summary && <p className="basis-full text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">{r.summary}</p>}
              {r.error && <p className="basis-full text-xs text-[var(--text-tertiary)]">{r.error}</p>}
              {r.resultUrl && <a className="basis-full text-sm text-[var(--brand-500)] hover:underline break-all" href={r.resultUrl} target="_blank" rel="noopener noreferrer">{r.resultUrl}</a>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
