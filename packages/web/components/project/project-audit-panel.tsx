'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { Pager } from '@/components/pager'
import { useDebouncedValue } from '@/hooks/use-debounced'

interface Row { id: number; createdAt: string; actor: string | null; action: string; targetType: string; target: string | null; method: string | null; status: number | null }
const PAGE = 50

/** The audit trail of one project: changes to the project itself and to its issues. */
export function ProjectAuditPanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const [search, setSearch] = useState('')
  const [start, setStart] = useState(0)
  const q = useDebouncedValue(search.trim())
  const data = useQuery({
    queryKey: ['project-audit', projectKey, q, start], placeholderData: (p) => p,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/audit?startAt=${start}&maxResults=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { credentials: 'include' })
      if (!r.ok) throw new Error('Could not load the audit log')
      return (await r.json()) as { total: number; values: Row[] }
    },
  })
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Audit log')}</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-3xl">{tr('Who changed what in this project: settings, roles, permissions and issues. The whole instance’s log is in Administration.')}</p>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
        <input className="veqsio-input w-full pl-9" placeholder={tr('Filter by person, action or target…')} value={search} onChange={(e) => { setSearch(e.target.value); setStart(0) }} aria-label={tr('Filter the audit log')} />
      </div>
      {data.isLoading ? <div className="flex justify-center py-12"><Spinner /></div> : data.error ? <p className="text-[var(--error)]">{tr('Could not load the audit log.')}</p> : (
        <div className="rounded-lg border border-[var(--surface-3)] overflow-hidden">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr('Audit log of')} {projectKey}</caption>
            <thead><tr className="veqsio-table-header text-left"><th scope="col">{tr('When')}</th><th scope="col">{tr('Who')}</th><th scope="col">{tr('Action')}</th><th scope="col">{tr('Target')}</th><th scope="col" className="text-right">{tr('Result')}</th></tr></thead>
            <tbody>
              {(data.data?.values ?? []).length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--text-tertiary)]">{tr('Nothing recorded for this project yet.')}</td></tr>}
              {(data.data?.values ?? []).map((r) => (
                <tr key={r.id} className="veqsio-table-row">
                  <td className="px-4 py-2 whitespace-nowrap text-[var(--text-secondary)]">{new Date(r.createdAt).toLocaleString(getIntlLocale())}</td>
                  <td className="px-4 py-2">{r.actor ?? 'system'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-4 py-2">{r.target ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.status ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager startAt={start} pageSize={PAGE} total={data.data?.total ?? 0} shown={data.data?.values.length ?? 0} onPage={setStart} />
    </div>
  )
}
