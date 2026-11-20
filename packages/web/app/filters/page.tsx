'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Share2, Trash2 } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { Modal } from '@/components/modal'
import { ShareDialog } from '@/components/share-dialog'
import { JqlInput } from '@/components/jql-input'
import { toast } from '@/components/toast'
import { confirmDialog } from '@/components/dialogs'

type Share = { type: 'user' | 'group' | 'project' | 'global'; id?: number }
interface Filter { id: string; name: string; jql: string; owner: { id: number; displayName: string | null }; editable: boolean; shares?: Share[] }
interface Subscription { schedule: 'daily' | 'weekly'; hour: number; weekday: number | null; emptyPolicy: 'skip' | 'send' }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function FiltersPage() {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [tab, setTab] = useState<'mine' | 'shared'>('mine')
  const [name, setName] = useState('')
  const [jql, setJql] = useState('')
  const [sharing, setSharing] = useState<Filter | null>(null)
  const [subscribing, setSubscribing] = useState<Filter | null>(null)

  const list = useQuery({
    queryKey: ['filters', tab],
    queryFn: () => api<{ values: Filter[] }>(`/rest/api/2/filter/search?shared=${tab === 'shared'}&maxResults=100`),
  })
  const create = useMutation({
    mutationFn: () => api('/rest/api/2/filter', { method: 'POST', body: JSON.stringify({ name, jql }) }),
    onSuccess: () => { setName(''); setJql(''); qc.invalidateQueries({ queryKey: ['filters'] }); toast(tr('Filter saved'), 'success') },
    onError: (e) => toast((e as Error).message, 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/rest/api/2/filter/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filters'] }),
    onError: (e) => toast((e as Error).message, 'error'),
  })

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Filters')} description={tr('Saved searches you can reuse, share and subscribe to.')} />

        <form className="veqsio-card p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && jql.trim()) create.mutate() }}>
          <h2 className="text-heading-3">{tr('New filter')}</h2>
          <label className="block text-sm space-y-1">{tr('Name')} <input className="veqsio-input w-full" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="text-sm space-y-1"><span>{tr('Query')}</span><JqlInput value={jql} onChange={setJql} /></div>
          <button className="veqsio-btn-primary" disabled={create.isPending || !name.trim() || !jql.trim()}>{tr('Save filter')}</button>
        </form>

        <div role="tablist" className="flex gap-1">
          {(['mine', 'shared'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => setTab(t)}>
              {t === 'mine' ? tr('My filters') : tr('Shared with me')}
            </button>
          ))}
        </div>

        {list.isLoading && <Spinner />}
        {list.error && <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p>}
        {list.data?.values.length === 0 && <p className="text-[var(--text-tertiary)]">{tab === 'mine' ? tr('You have no saved filters yet.') : tr('Nothing has been shared with you.')}</p>}
        <ul className="space-y-2">
          {list.data?.values.map((f) => (
            <li key={f.id} className="veqsio-card p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/issues?jql=${encodeURIComponent(f.jql)}`} className="font-medium text-[var(--brand-500)] hover:underline">{f.name}</Link>
                <div className="font-mono text-xs text-[var(--text-secondary)] truncate max-w-xl" title={f.jql}>{f.jql}</div>
                {tab === 'shared' && <div className="text-xs text-[var(--text-tertiary)]">{tr('by')} {f.owner.displayName ?? tr('unknown')}</div>}
              </div>
              <div className="flex gap-1">
                <button className="veqsio-btn-ghost p-2" title={tr('Email me this filter on a schedule')} aria-label={tr('Subscribe to {name}', { name: f.name })} onClick={() => setSubscribing(f)}><Bell className="w-4 h-4" /></button>
                {f.editable && <button className="veqsio-btn-ghost p-2" title={tr('Share')} aria-label={tr('Share {name}', { name: f.name })} onClick={() => setSharing(f)}><Share2 className="w-4 h-4" /></button>}
                {f.editable && <button className="veqsio-btn-ghost p-2" title={tr('Delete')} aria-label={tr('Delete {name}', { name: f.name })} onClick={async () => (await confirmDialog(tr('Delete filter "{name}"?', { name: f.name }))) && remove.mutate(f.id)}><Trash2 className="w-4 h-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {sharing && <ShareDialog title={tr('Share "{name}"', { name: sharing.name })} initial={sharing.shares ?? []} save={(shares) => api(`/rest/api/2/filter/${sharing.id}/share`, { method: 'PUT', body: JSON.stringify({ shares }) })} onClose={() => { setSharing(null); qc.invalidateQueries({ queryKey: ['filters'] }) }} />}
      {subscribing && <SubscribeDialog filter={subscribing} onClose={() => setSubscribing(null)} />}
    </AppLayout>
  )
}

function SubscribeDialog({ filter, onClose }: { filter: Filter; onClose: () => void }) {
  const { tr } = useI18n();

  const [sub, setSub] = useState<Subscription>({ schedule: 'daily', hour: 8, weekday: 1, emptyPolicy: 'skip' })
  const [exists, setExists] = useState(false)
  useQuery({
    queryKey: ['filter-sub', filter.id],
    queryFn: async () => {
      const res = await fetch(`/rest/api/2/filter/${filter.id}/subscription`, { credentials: 'include' })
      if (res.ok) { const s = await res.json(); setSub({ schedule: s.schedule, hour: s.hour, weekday: s.weekday ?? 1, emptyPolicy: s.emptyPolicy }); setExists(true) }
      return null
    },
  })
  const save = useMutation({
    mutationFn: () => api(`/rest/api/2/filter/${filter.id}/subscription`, { method: 'PUT', body: JSON.stringify({ ...sub, weekday: sub.schedule === 'weekly' ? sub.weekday : null }) }),
    onSuccess: () => { toast(tr('Subscription saved'), 'success'); onClose() },
    onError: (e) => toast((e as Error).message, 'error'),
  })
  const unsubscribe = useMutation({
    mutationFn: () => api(`/rest/api/2/filter/${filter.id}/subscription`, { method: 'DELETE' }),
    onSuccess: () => { toast(tr('Unsubscribed'), 'success'); onClose() },
  })
  return (
    <Modal isOpen onClose={onClose} title={tr('Email me "{name}"', { name: filter.name })}>
      <div className="space-y-3 text-sm">
        <label className="block space-y-1">{tr('Frequency')} <select className="veqsio-input block" value={sub.schedule} onChange={(e) => setSub({ ...sub, schedule: e.target.value as any })}>
            <option value="daily">{tr('Every day')}</option><option value="weekly">{tr('Every week')}</option>
          </select>
        </label>
        {sub.schedule === 'weekly' && (
          <label className="block space-y-1">{tr('On')} <select className="veqsio-input block" value={sub.weekday ?? 1} onChange={(e) => setSub({ ...sub, weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{tr(d)}</option>)}
            </select>
          </label>
        )}
        <label className="block space-y-1">{tr('At (UTC)')} <select className="veqsio-input block" value={sub.hour} onChange={(e) => setSub({ ...sub, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={sub.emptyPolicy === 'send'} onChange={(e) => setSub({ ...sub, emptyPolicy: e.target.checked ? 'send' : 'skip' })} /> {tr('Send even when there are no matching issues')}</label>
        <div className="flex justify-between gap-2">
          <div>{exists && <button className="veqsio-btn-secondary" onClick={() => unsubscribe.mutate()}>{tr('Unsubscribe')}</button>}</div>
          <div className="flex gap-2">
            <button className="veqsio-btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
            <button className="veqsio-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{tr('Save')}</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
