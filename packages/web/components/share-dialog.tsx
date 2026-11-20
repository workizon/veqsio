'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'

export type Share = { type: 'user' | 'group' | 'project' | 'global'; id?: number }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

/**
 * Share dialog used by saved filters and saved views: everybody who can sign in, or specific users, groups
 * and projects. Candidates come from /rest/api/2/filter/share-targets (only things the sharer may use).
 */
export function ShareDialog({ title, initial, save, onClose }: { title: string; initial: Share[]; save: (shares: Share[]) => Promise<unknown>; onClose: () => void }) {
  const { tr } = useI18n();

  const [shares, setShares] = useState<Share[]>(initial)
  const [type, setType] = useState<'user' | 'group' | 'project'>('user')
  const [q, setQ] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const targets = useQuery({
    queryKey: ['share-targets', type, q], enabled: q.length >= 1,
    queryFn: () => api<{ values: Array<{ id: number; name: string }> }>(`/rest/api/2/filter/share-targets?type=${type}&q=${encodeURIComponent(q)}`),
  })
  const global = shares.some((s) => s.type === 'global')
  const mutation = useMutation({
    mutationFn: () => save(shares),
    onSuccess: () => { toast(tr('Sharing updated'), 'success'); onClose() },
    onError: (e) => toast((e as Error).message, 'error'),
  })
  return (
    <Modal isOpen onClose={onClose} title={title}>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={global} onChange={(e) => setShares(e.target.checked ? [...shares, { type: 'global' }] : shares.filter((s) => s.type !== 'global'))} />
          {tr('Everyone who can sign in')} </label>
        <div className="flex gap-2">
          <select aria-label={tr('Share with')} className="veqsio-input" value={type} onChange={(e) => { setType(e.target.value as any); setQ('') }}>
            <option value="user">{tr('A user')}</option><option value="group">{tr('A group')}</option><option value="project">{tr('A project')}</option>
          </select>
          <input aria-label={tr('Search')} className="veqsio-input flex-1" placeholder={tr('Start typing…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {targets.data && q && (
          <ul className="border border-[var(--surface-3)] rounded max-h-40 overflow-auto">
            {targets.data.values.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">{tr('No matches')}</li>}
            {targets.data.values.map((t) => (
              <li key={t.id}><button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                onClick={() => { if (!shares.some((s) => s.type === type && s.id === t.id)) { setShares([...shares, { type, id: t.id }]); setNames({ ...names, [`${type}:${t.id}`]: t.name }) } setQ('') }}>{t.name}</button></li>
            ))}
          </ul>
        )}
        <ul className="flex flex-wrap gap-2">
          {shares.filter((s) => s.type !== 'global').map((s) => (
            <li key={`${s.type}:${s.id}`} className="text-xs rounded bg-[var(--surface-2)] px-2 py-1">
              {s.type} · {names[`${s.type}:${s.id}`] ?? `#${s.id}`}{' '}
              <button type="button" aria-label={tr('Remove')} onClick={() => setShares(shares.filter((x) => x !== s))}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button className="veqsio-btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button className="veqsio-btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{tr('Save')}</button>
        </div>
      </div>
    </Modal>
  )
}
