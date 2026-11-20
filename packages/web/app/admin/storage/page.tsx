'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'

interface Row { key: string; name: string; files: number; bytes: number; quotaMb: number; ownQuota: boolean }
interface Result { backend: string; maxFileSizeBytes: number; totalFiles: number; totalBytes: number; instanceQuotaMb: number; projects: Row[] }

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round(b / 1024))} KB`)

function QuotaCell({ row }: { row: Row }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [value, setValue] = useState(row.ownQuota ? String(row.quotaMb) : '')
  const save = useMutation({
    mutationFn: async (quotaMb: number | null) => {
      const r = await fetch(`/rest/api/2/admin/system/storage/quota/${encodeURIComponent(row.key)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quotaMb }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.errorMessages?.[0] ?? 'Could not save')
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'storage'] }); toast(tr('Limit saved'), 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const parsed = value.trim() === '' ? null : Number(value)
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 0)
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`q-${row.key}`}>{tr('Limit for')} {row.name} {tr('in MB')}</label>
      <input id={`q-${row.key}`} className="veqsio-input w-28 !py-1" inputMode="numeric" value={value} placeholder={row.quotaMb > 0 ? `${row.quotaMb} (default)` : 'no limit'} onChange={(e) => setValue(e.target.value)} aria-invalid={invalid} />
      <button type="button" className="veqsio-btn-secondary !py-1" disabled={save.isPending || invalid} onClick={() => save.mutate(parsed)}>{tr('Save')}</button>
    </div>
  )
}

export default function StoragePage() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'storage'],
    queryFn: async () => {
      const r = await fetch('/rest/api/2/admin/system/storage', { credentials: 'include' })
      if (!r.ok) throw new Error(r.statusText)
      return (await r.json()) as Result
    },
  })
  return (
    <AppLayout>
      <PageHeader title={tr('Storage')} breadcrumb={[{ label: 'Administration', href: '/admin' }, { label: 'Storage' }]} description={tr('How much attachment data each project holds, and a limit per project. An upload that would go over its limit is refused.')} />
      <div className="space-y-4 max-w-4xl">
        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-sm text-[var(--error)]">{(error as Error).message}</p>}
        {data && (
          <>
            <section className="veqsio-card p-4 text-sm space-y-1" aria-label={tr('Totals')}>
              <p><strong>{mb(data.totalBytes)}</strong> in {data.totalFiles} {tr('files, stored in:')} {data.backend}. One file may be up to {mb(data.maxFileSizeBytes)}.</p>
              <p className="text-[var(--text-secondary)]">
                {tr('Limit for every project:')} {data.instanceQuotaMb > 0 ? `${data.instanceQuotaMb} MB` : 'none'}. Change it under <Link className="text-[var(--brand-500)] hover:underline" href="/admin/settings">{tr('Settings → Attachments')}</Link>. A limit set below overrides it for that project; leave the field empty to use the one for every project, enter 0 for no limit at all.
              </p>
            </section>
            <section className="veqsio-card p-0 overflow-x-auto" aria-label={tr('Storage per project')}>
              <table className="w-full text-sm">
                <caption className="sr-only">{tr('Attachment storage per project')}</caption>
                <thead><tr className="text-left bg-[var(--surface-1)]"><th scope="col" className="px-4 py-2">{tr('Project')}</th><th scope="col" className="px-4 py-2 text-right">{tr('Files')}</th><th scope="col" className="px-4 py-2 text-right">{tr('Used')}</th><th scope="col" className="px-4 py-2">{tr('Of the limit')}</th><th scope="col" className="px-4 py-2">{tr('Limit (MB)')}</th></tr></thead>
                <tbody>
                  {data.projects.map((p) => {
                    const pct = p.quotaMb > 0 ? Math.min(100, Math.round((p.bytes / (p.quotaMb * 1048576)) * 100)) : null
                    return (
                      <tr key={p.key} className="border-t border-[var(--surface-3)]">
                        <td className="px-4 py-2"><span className="font-medium">{p.name}</span> <span className="font-mono text-xs text-[var(--text-tertiary)]">{p.key}</span></td>
                        <td className="px-4 py-2 text-right tabular-nums">{p.files}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{mb(p.bytes)}</td>
                        <td className="px-4 py-2 w-40">
                          {pct === null ? <span className="text-[var(--text-tertiary)]">{tr('no limit')}</span> : (
                            <div className="flex items-center gap-2" title={`${pct}% of ${p.quotaMb} MB`}>
                              <div className="h-1.5 flex-1 rounded-full bg-[var(--surface-3)] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} storage used`}>
                                <div className={`h-full rounded-full ${pct >= 90 ? 'bg-[var(--error)]' : pct >= 75 ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-9 text-right text-xs tabular-nums">{pct}%</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2"><QuotaCell row={p} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  )
}
