'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { confirmDialog } from '@/components/dialogs'

interface Detail {
  id: number; name: string; description: string | null; importance: number; annualRevenue: number | null; currency: string; canEdit: boolean
  issues: { key: string; summary: string; status: string; statusCategory: string; note: string | null }[]
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

export default function CustomerPage() {
  const { tr } = useI18n();

  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api<Detail>(`/rest/api/2/customer/${id}`) })
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [importance, setImportance] = useState(3)
  const [revenue, setRevenue] = useState('')
  const [currency, setCurrency] = useState('USD')
  const start = (d: Detail) => { setName(d.name); setDescription(d.description ?? ''); setImportance(d.importance); setRevenue(d.annualRevenue === null ? '' : String(d.annualRevenue)); setCurrency(d.currency); setEditing(true) }
  const save = useMutation({
    mutationFn: () => api(`/rest/api/2/customer/${id}`, { method: 'PUT', body: JSON.stringify({ name, description: description || null, importance, annualRevenue: revenue === '' ? null : Number(revenue), currency: currency.toUpperCase() }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customer', id] }); qc.invalidateQueries({ queryKey: ['customers'] }); setEditing(false); toast(tr('Customer saved'), 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api(`/rest/api/2/customer/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); router.push('/customers') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  if (q.isLoading) return <AppLayout><Spinner /></AppLayout>
  if (q.error || !q.data) return <AppLayout><p role="alert" className="p-6 text-sm text-[var(--error)]">{(q.error as Error)?.message ?? tr('Not found')}</p></AppLayout>
  const d = q.data
  const open = d.issues.filter((i) => i.statusCategory !== 'done')
  return (
    <AppLayout>
      <div className="space-y-5">
        <Breadcrumb items={[{ label: tr('Customers'), href: '/customers' }, { label: d.name }]} />
        {editing ? (
          <div className="veqsio-card p-4 space-y-3">
            <input className="veqsio-input w-full" aria-label={tr('Name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            <textarea className="veqsio-input w-full" aria-label={tr('Description')} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="flex flex-wrap gap-4">
              <label className="text-sm">{tr('Importance')} <select className="veqsio-input block mt-1" value={importance} onChange={(e) => setImportance(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {tr('of 5')}</option>)}</select></label>
              <label className="text-sm">{tr('Annual revenue')} <input type="number" min={0} className="veqsio-input block mt-1 w-40" value={revenue} onChange={(e) => setRevenue(e.target.value)} /></label>
              <label className="text-sm">{tr('Currency')} <input className="veqsio-input block mt-1 w-20" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} /></label>
            </div>
            <div className="flex gap-2"><button className="veqsio-btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>{tr('Save')}</button><button className="veqsio-btn-ghost" onClick={() => setEditing(false)}>{tr('Cancel')}</button></div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="text-heading-1 text-[var(--text-primary)]">{d.name}</h1>
              <p className="text-sm mt-1"><span className="text-[var(--warning)]" aria-label={tr('Importance {n} of 5', { n: d.importance })}>{'★'.repeat(d.importance)}{'☆'.repeat(5 - d.importance)}</span> · {d.annualRevenue === null ? tr('Revenue not set') : tr('{amount} per year', { amount: new Intl.NumberFormat(undefined, { style: 'currency', currency: d.currency, maximumFractionDigits: 0 }).format(d.annualRevenue) })}</p>
              {d.description && <p className="text-sm text-[var(--text-secondary)] mt-1">{d.description}</p>}
            </div>
            {d.canEdit && <><button className="veqsio-btn-secondary" onClick={() => start(d)}>{tr('Edit')}</button><button className="veqsio-btn-ghost" onClick={async () => { if ((await confirmDialog(tr('Delete customer "{name}"? The issues stay.', { name: d.name })))) remove.mutate() }}>{tr('Delete')}</button></>}
          </div>
        )}
        <section aria-label={tr('Linked issues')}>
          <h2 className="text-sm font-medium mb-2">{tr('Linked issues (')}{open.length} {tr('open,')} {d.issues.length - open.length} {tr('done)')}</h2>
          <ul className="veqsio-card divide-y divide-[var(--surface-3)] text-sm">
            {d.issues.map((i) => (
              <li key={i.key} className="px-3 py-2 flex flex-wrap gap-x-3">
                <Link href={`/issues/${i.key}`} className="font-medium">{i.key}</Link>
                <span className="flex-1 min-w-0 truncate">{i.summary}</span>
                <span className="text-[var(--text-secondary)]">{i.status}</span>
                {i.note && <span className="w-full text-xs text-[var(--text-tertiary)]">{i.note}</span>}
              </li>
            ))}
            {!d.issues.length && <li className="px-3 py-2 text-[var(--text-tertiary)]">{tr('No issues linked yet. Open an issue and add this customer under Customers.')}</li>}
          </ul>
        </section>
      </div>
    </AppLayout>
  )
}
