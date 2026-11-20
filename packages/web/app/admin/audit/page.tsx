'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'

interface AuditEntry {
  id: number
  createdAt: string
  actorName: string | null
  action: string
  targetType: string
  target: string | null
  ip: string | null
  details: { fields?: string[] } | null
}
interface AuditResponse { startAt: number; maxResults: number; total: number; targetTypes: string[]; entries: AuditEntry[] }

const PAGE = 50

export default function AdminAuditPage() {
  const { tr } = useI18n();

  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [targetType, setTargetType] = useState('')
  const [text, setText] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)

  const params = new URLSearchParams()
  if (actor) params.set('actor', actor)
  if (action) params.set('action', action)
  if (targetType) params.set('targetType', targetType)
  if (text) params.set('q', text)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const filterQuery = params.toString()

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'audit', filterQuery, page],
    queryFn: async () => {
      const res = await fetch(`/rest/api/2/admin/audit?${filterQuery}&startAt=${page * PAGE}&maxResults=${PAGE}`, { credentials: 'include' })
      if (!res.ok) throw new Error(res.status === 403 ? tr('System administrator rights are required') : res.statusText)
      return (await res.json()) as AuditResponse
    },
  })

  const setFilter = (setter: (v: string) => void) => (e: { target: { value: string } }) => { setter(e.target.value); setPage(0) }
  const total = data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1)

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Audit log')} description={tr('Administrative changes: who did what, to which object, when and from where. Secrets and passwords are never recorded.')}
          actions={<><a
            className="veqsio-btn-secondary flex items-center gap-2 shrink-0"
            href={`/rest/api/2/admin/audit/export?${filterQuery}`}
            download
          >
            <Download className="w-4 h-4" aria-hidden /> {tr('Export CSV')} </a></>} />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <input aria-label={tr('Filter by actor')} className="veqsio-input" placeholder={tr('Actor')} value={actor} onChange={setFilter(setActor)} />
          <input aria-label={tr('Filter by action')} className="veqsio-input" placeholder={tr('Action (e.g. USER_DELETED)')} value={action} onChange={setFilter(setAction)} />
          <select aria-label={tr('Filter by target type')} className="veqsio-input" value={targetType} onChange={setFilter(setTargetType)}>
            <option value="">{tr('All object types')}</option>
            {(data?.targetTypes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input aria-label={tr('Search target or path')} className="veqsio-input" placeholder={tr('Search target')} value={text} onChange={setFilter(setText)} />
          <input aria-label={tr('From date')} type="date" className="veqsio-input" value={from} onChange={setFilter(setFrom)} />
          <input aria-label={tr('To date')} type="date" className="veqsio-input" value={to} onChange={setFilter(setTo)} />
        </div>

        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-[var(--error)]">{(error as Error).message}</p>}

        {data && (
          data.entries.length === 0 ? (
            <p className="text-[var(--text-secondary)] py-8 text-center">{tr('No audit entries match these filters.')}</p>
          ) : (
            <div className="border border-[var(--surface-3)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="veqsio-table-header">
                    <th className="text-left">{tr('Time')}</th>
                    <th className="text-left">{tr('Actor')}</th>
                    <th className="text-left">{tr('Action')}</th>
                    <th className="text-left">{tr('Target')}</th>
                    <th className="text-left">{tr('IP')}</th>
                    <th className="text-left hidden lg:table-cell">{tr('Changed fields')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className="veqsio-table-row">
                      <td className="px-4 py-2 whitespace-nowrap text-[var(--text-secondary)]">{new Date(e.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2">{e.actorName ?? tr('unknown')}</td>
                      <td className="px-4 py-2"><span className="veqsio-badge veqsio-badge-status-todo">{e.action}</span></td>
                      <td className="px-4 py-2 text-[var(--text-secondary)]">{e.targetType}{e.target ? ` / ${e.target}` : ''}</td>
                      <td className="px-4 py-2 font-mono text-[var(--text-tertiary)]">{e.ip ?? ''}</td>
                      <td className="px-4 py-2 hidden lg:table-cell text-[var(--text-tertiary)] max-w-xs truncate">{e.details?.fields?.join(', ') ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {data && total > PAGE && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--text-secondary)]">{total} {tr('entries, page')} {tr('{page} of {last}', { page: page + 1, last: lastPage + 1 })}</span>
            <div className="flex gap-2">
              <button className="veqsio-btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>{tr('Previous')}</button>
              <button className="veqsio-btn-secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>{tr('Next')}</button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
