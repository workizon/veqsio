'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { History } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { useWorkflowHistory } from '@/hooks/use-issue-history'

const fmt = (iso: string) => new Date(iso).toLocaleString(getIntlLocale(), { dateStyle: 'medium', timeStyle: 'short' })

/** Who changed which transition, status or condition of this workflow, newest first. */
export function WorkflowHistoryList({ workflowId }: { workflowId: number }) {
  const { tr } = useI18n();

  const { data, isLoading, error } = useWorkflowHistory(workflowId)
  return (
    <section className="veqsio-card p-4" aria-labelledby="wf-history-heading">
      <h2 id="wf-history-heading" className="text-heading-3 text-[var(--text-primary)] flex items-center gap-2"><History className="w-4 h-4" aria-hidden /> {tr('Change history')}</h2>
      {isLoading && <div className="py-3"><Spinner size="sm" /></div>}
      {error && <p role="alert" className="text-sm text-[var(--error)] mt-2">{(error as Error).message}</p>}
      {data && data.length === 0 && <p className="text-sm text-[var(--text-tertiary)] mt-2">{tr('No changes recorded yet. Changes made from now on are listed here.')}</p>}
      {data && data.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--surface-2)] max-h-80 overflow-auto" aria-label={tr('Workflow changes')}>
          {data.map((e) => (
            <li key={e.id} className="py-1.5 text-sm">
              <span className="text-[var(--text-primary)]">{e.summary}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{e.actor?.name ?? tr('System')} · {fmt(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
