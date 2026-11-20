'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { Modal } from '@/components/modal'

interface Row { id: number; name: string; description: string | null; members: number; projects: number }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

export default function TeamspacesPage() {
  const { tr } = useI18n();

  const router = useRouter()
  const list = useQuery({ queryKey: ['teamspaces'], queryFn: () => api<{ teamspaces: Row[] }>('/rest/api/2/teamspace').then((r) => r.teamspaces) })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/rest/api/2/teamspace', { method: 'POST', body: JSON.stringify({ name, description: description || null }) }),
    onSuccess: (r) => router.push(`/teams/${r.id}`),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader breadcrumb={[{ label: tr('Teamspaces') }]} title={tr('Teamspaces')} description={tr('A teamspace brings a team and the projects it works in together, with one view of its open work.')} actions={<button className="veqsio-btn-primary" onClick={() => setOpen(true)}>{tr('New teamspace')}</button>} />
        {list.isLoading ? <Spinner /> : list.error ? <p role="alert" className="text-sm text-[var(--error)]">{(list.error as Error).message}</p> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {(list.data ?? []).map((t) => (
              <li key={t.id}>
                <Link href={`/teams/${t.id}`} className="veqsio-card p-4 block no-underline hover:border-[var(--surface-4)]">
                  <p className="font-medium text-[var(--text-primary)]">{t.name}</p>
                  <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{t.description || tr('No description')}</p>
                  <p className="text-xs text-[var(--text-tertiary)] mt-2">{t.members} {tr('people ·')} {t.projects} {t.projects === 1 ? tr('project') : tr('projects')}</p>
                </Link>
              </li>
            ))}
            {!list.data?.length && <li className="text-sm text-[var(--text-tertiary)]">{tr('No teamspaces yet.')}</li>}
          </ul>
        )}
      </div>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={tr('New teamspace')}>
        <div className="space-y-3">
          <input className="veqsio-input w-full" aria-label={tr('Name')} placeholder={tr('Name, for example Platform')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <textarea className="veqsio-input w-full" aria-label={tr('Description')} placeholder={tr('What does this team do? (optional)')} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-ghost" onClick={() => setOpen(false)}>{tr('Cancel')}</button>
            <button className="veqsio-btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>{tr('Create')}</button>
          </div>
        </div>
      </Modal>
    </AppLayout>
  )
}
