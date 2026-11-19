'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'
import { confirmDialog } from '@/components/dialogs'

interface AdminLinkType { id: string; name: string; inward: string; outward: string; scheduling: string | null; isSystem: boolean; linkCount: number }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

const SCHEDULING_NOTE: Record<string, string> = {
  starts_before: 'Dependency: the predecessor must start on or before the day the successor starts.',
  finishes_before: 'Dependency: the predecessor must finish on or before the day the successor starts.',
}

export default function LinkTypesAdminPage() {
  const ms = useMultiSort()
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['admin-linktypes'], queryFn: () => api<{ issueLinkTypes: AdminLinkType[] }>('/rest/api/2/admin/linktype').then((r) => r.issueLinkTypes) })
  const [name, setName] = useState('')
  const [outward, setOutward] = useState('')
  const [inward, setInward] = useState('')
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-linktypes'] }); qc.invalidateQueries({ queryKey: ['issueLinkTypes'] }) }
  const create = useMutation({
    mutationFn: () => api('/rest/api/2/admin/linktype', { method: 'POST', body: JSON.stringify({ name, inward, outward }) }),
    onSuccess: () => { setName(''); setInward(''); setOutward(''); refresh(); toast('Link type created', 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/rest/api/2/admin/linktype/${id}`, { method: 'DELETE' }),
    onSuccess: () => { refresh(); toast('Link type deleted', 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader breadcrumb={[{ label: 'Administration', href: '/admin' }, { label: 'Link types' }]} title="Issue link types" description="A link shows one sentence on each issue (for example “blocks” on one and “is blocked by” on the other). Built-in types cannot be changed; add your own below." />

        {list.isLoading && <Spinner />}
        {list.error && <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p>}
        {list.data && (
          <table className="w-full text-sm veqsio-card p-0">
            <caption className="sr-only">Link types</caption>
            <thead><tr className="text-left text-[var(--text-tertiary)]"><SortableTh {...ms.th('name')} className="p-2">Name</SortableTh><SortableTh {...ms.th('outward')} className="p-2">Outward</SortableTh><SortableTh {...ms.th('inward')} className="p-2">Inward</SortableTh><SortableTh {...ms.th('links')} className="p-2">Links</SortableTh><th scope="col" className="p-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {ms.sort(list.data, { name: (t) => t.name, outward: (t) => t.outward, inward: (t) => t.inward, links: (t) => t.linkCount }).map((t) => (
                <tr key={t.id} className="border-t border-[var(--surface-3)] align-top">
                  <td className="p-2"><span className="font-medium">{t.name}</span> {t.isSystem && <span className="text-xs text-[var(--text-tertiary)]">built-in</span>}
                    {t.scheduling && <div className="text-xs text-[var(--text-tertiary)]">{SCHEDULING_NOTE[t.scheduling]}</div>}</td>
                  <td className="p-2">{t.outward}</td>
                  <td className="p-2">{t.inward}</td>
                  <td className="p-2">{t.linkCount}</td>
                  <td className="p-2 text-right">
                    {!t.isSystem && (
                      <button type="button" className="veqsio-btn-secondary text-xs" disabled={remove.isPending || t.linkCount > 0} title={t.linkCount > 0 ? `Used by ${t.linkCount} links; remove them first` : undefined} onClick={async () => { if ((await confirmDialog(`Delete link type “${t.name}”?`))) remove.mutate(t.id) }}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} className="veqsio-card space-y-3">
          <h2 className="text-heading-3">New link type</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label htmlFor="lt-name" className="text-caption block mb-1">Name</label><input id="lt-name" className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="Causes" /></div>
            <div><label htmlFor="lt-out" className="text-caption block mb-1">Outward sentence</label><input id="lt-out" className="veqsio-input w-full" value={outward} onChange={(e) => setOutward(e.target.value)} maxLength={100} required placeholder="causes" /></div>
            <div><label htmlFor="lt-in" className="text-caption block mb-1">Inward sentence</label><input id="lt-in" className="veqsio-input w-full" value={inward} onChange={(e) => setInward(e.target.value)} maxLength={100} required placeholder="is caused by" /></div>
          </div>
          <button type="submit" className="veqsio-btn-primary text-sm" disabled={create.isPending || !name.trim() || !inward.trim() || !outward.trim()}>Add link type</button>
        </form>
      </div>
    </AppLayout>
  )
}
