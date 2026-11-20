'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/toast'

interface Cust { id: number; name: string; importance: number; annualRevenue: number | null; currency: string; note: string | null }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n)

/** "Customers" panel of an issue: who asked for it and how much they matter. Add and remove need edit rights. */
export function CustomersSection({ issueKey }: { issueKey: string }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const key = ['issue-customers', issueKey]
  const linked = useQuery({ queryKey: key, queryFn: () => api<{ customers: Cust[] }>(`/rest/api/2/issue/${issueKey}/customer`).then((r) => r.customers) })
  const all = useQuery({ queryKey: ['customers'], queryFn: () => api<{ customers: { id: number; name: string }[] }>('/rest/api/2/customer').then((r) => r.customers) })
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const add = useMutation({
    mutationFn: () => api(`/rest/api/2/issue/${issueKey}/customer`, { method: 'POST', body: JSON.stringify({ customerId: Number(pick), note: note || null }) }),
    onSuccess: () => { setPick(''); setNote(''); qc.invalidateQueries({ queryKey: key }) },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api(`/rest/api/2/issue/${issueKey}/customer/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const ids = new Set((linked.data ?? []).map((c) => c.id))
  const options = (all.data ?? []).filter((c) => !ids.has(c.id))
  if (linked.isLoading || linked.error) return null
  if (!linked.data?.length && !options.length) return null
  return (
    <section aria-label={tr('Customers')} className="mt-6">
      <h3 className="text-heading-3 mb-2">{tr('Customers')}</h3>
      <ul className="space-y-1.5 mb-2">
        {(linked.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-body-sm">
            <Link href={`/customers/${c.id}`} className="font-medium">{c.name}</Link>
            <span className="text-[var(--warning)]" title={`Importance ${c.importance} of 5`} aria-label={`Importance ${c.importance} of 5`}>{stars(c.importance)}</span>
            {c.annualRevenue !== null && <span className="text-caption text-[var(--text-secondary)]">{new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(c.annualRevenue)}/yr</span>}
            {c.note && <span className="text-caption text-[var(--text-tertiary)] truncate">{c.note}</span>}
            <button className="ml-auto veqsio-btn-ghost text-caption" onClick={() => del.mutate(c.id)} aria-label={`Remove ${c.name}`}>{tr('Remove')}</button>
          </li>
        ))}
      </ul>
      {options.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select className="veqsio-input" aria-label={tr('Customer')} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{tr('Add a customer…')}</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {pick && <input className="veqsio-input" aria-label={tr('Note')} placeholder={tr('Why they need it (optional)')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
          {pick && <button className="veqsio-btn-secondary" disabled={add.isPending} onClick={() => add.mutate()}>{tr('Add')}</button>}
        </div>
      )}
    </section>
  )
}
