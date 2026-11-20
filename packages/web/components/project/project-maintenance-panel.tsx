'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useMutation } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from '@/components/toast'

/** Jira's "Re-index project". Veqsio searches the database directly, so there is no index to rebuild: this refreshes the cached data. */
export function ProjectMaintenancePanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const run = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/reindex`, { method: 'POST', credentials: 'include' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).errorMessages?.[0] || 'The refresh failed')
      return (await r.json()) as { issues: number; tookMs: number }
    },
    onSuccess: (d) => toast(`Refreshed ${d.issues.toLocaleString()} issue${d.issues === 1 ? '' : 's'} in ${d.tookMs} ms`, 'success'),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Re-index project')}</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Search, boards and reports read straight from the database, so there is no separate search index to rebuild. If this project’s lists look out of date (for example after a bulk change made outside Veqsio), refresh the cached data of {projectKey}{tr(': issue lists, counts, permissions and board data are read again on the next request.')} </p>
      </div>
      <button type="button" className="veqsio-btn-primary inline-flex items-center gap-2 disabled:opacity-60" disabled={run.isPending} onClick={() => run.mutate()}>
        <RefreshCw className={`w-4 h-4 ${run.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />{run.isPending ? 'Refreshing…' : 'Refresh project data'}
      </button>
    </div>
  )
}
