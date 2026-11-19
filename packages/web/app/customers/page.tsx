'use client'

import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'
import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { Modal } from '@/components/modal'

interface Row { id: number; name: string; importance: number; annualRevenue: number | null; currency: string; linkedIssues: number }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}
const money = (n: number | null, cur: string) => (n === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n))

export default function CustomersPage() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const ms = useMultiSort()
  const list = useQuery({ queryKey: ['customers', query], queryFn: () => api<{ customers: Row[] }>(`/rest/api/2/customer?query=${encodeURIComponent(query)}`).then((r) => r.customers) })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [importance, setImportance] = useState(3)
  const [revenue, setRevenue] = useState('')
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/rest/api/2/customer', { method: 'POST', body: JSON.stringify({ name, importance, annualRevenue: revenue === '' ? null : Number(revenue) }) }),
    onSuccess: (r) => router.push(`/customers/${r.id}`),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader breadcrumb={[{ label: 'Customers' }]} title="Customers" description="Link customers to issues to see who is waiting for what, and how much they matter." actions={<button className="veqsio-btn-primary" onClick={() => setOpen(true)}>New customer</button>} />
        <input className="veqsio-input w-full sm:w-72" aria-label="Search customers" placeholder="Search customers" value={query} onChange={(e) => setQuery(e.target.value)} />
        {list.isLoading ? <Spinner /> : list.error ? <p role="alert" className="text-sm text-[var(--error)]">{(list.error as Error).message}</p> : (
          <div className="veqsio-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[var(--text-secondary)]"><SortableTh {...ms.th('name')} className="p-3 font-medium">Customer</SortableTh><SortableTh {...ms.th('importance')} className="p-3 font-medium">Importance</SortableTh><SortableTh {...ms.th('revenue')} className="p-3 font-medium">Annual revenue</SortableTh><SortableTh {...ms.th('issues')} className="p-3 font-medium">Linked issues</SortableTh></tr></thead>
              <tbody className="divide-y divide-[var(--surface-3)]">
                {ms.sort(list.data ?? [], { name: (c) => c.name, importance: (c) => c.importance, revenue: (c) => c.annualRevenue, issues: (c) => c.linkedIssues }).map((c) => (
                  <tr key={c.id}>
                    <td className="p-3"><Link href={`/customers/${c.id}`}>{c.name}</Link></td>
                    <td className="p-3 text-[var(--warning)]" aria-label={`${c.importance} of 5`}>{'★'.repeat(c.importance)}{'☆'.repeat(5 - c.importance)}</td>
                    <td className="p-3 tabular-nums">{money(c.annualRevenue, c.currency)}</td>
                    <td className="p-3 tabular-nums">{c.linkedIssues}</td>
                  </tr>
                ))}
                {!list.data?.length && <tr><td colSpan={4} className="p-3 text-[var(--text-tertiary)]">No customers yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="New customer">
        <div className="space-y-3">
          <input className="veqsio-input w-full" aria-label="Name" placeholder="Company or account name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          <label className="block text-sm">Importance
            <select className="veqsio-input block mt-1" value={importance} onChange={(e) => setImportance(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} of 5{n === 5 ? ' (critical account)' : n === 1 ? ' (low)' : ''}</option>)}
            </select>
          </label>
          <label className="block text-sm">Annual revenue (optional)
            <input type="number" min={0} className="veqsio-input block mt-1 w-48" value={revenue} onChange={(e) => setRevenue(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="veqsio-btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  )
}
