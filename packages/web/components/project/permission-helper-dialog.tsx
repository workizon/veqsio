'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useDismiss } from '@/hooks/use-dismiss'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Modal } from '@/components/modal'
import { useDebouncedValue } from '@/hooks/use-debounced'

interface Reason { kind: string; granted: boolean; decisive?: boolean; text: string }
interface Explanation { allowed: boolean; permission: string; user: { username: string; displayName: string }; reasons: Reason[] }

/** "Why can (or can't) this person do this in this project?" — the same evaluation the server uses for real checks. */
export function PermissionHelperDialog({ isOpen, onClose, projectKey, permissions }: { isOpen: boolean; onClose: () => void; projectKey: string; permissions: Array<{ key: string; name: string }> }) {
  const { tr } = useI18n();

  const [query, setQuery] = useState('')
  const q = useDebouncedValue(query.trim())
  const [user, setUser] = useState<{ id: number; name: string } | null>(null)
  const [listOpen, setListOpen] = useState(true)
  const listRef = useDismiss<HTMLDivElement>(listOpen, () => setListOpen(false))
  const [permission, setPermission] = useState(permissions[0]?.key ?? 'BROWSE_PROJECTS')
  const found = useQuery({
    queryKey: ['helper-user-search', q], enabled: isOpen && q.length > 0 && !user,
    queryFn: async () => { const r = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(q)}`, { credentials: 'include' }); return r.ok ? ((await r.json()) as Array<{ id: number; name: string; key: string }>) : [] },
  })
  const result = useQuery({
    queryKey: ['permission-helper', projectKey, user?.id, permission], enabled: isOpen && !!user,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/admin/permission-helper?userId=${user!.id}&permission=${permission}&projectKey=${encodeURIComponent(projectKey)}`, { credentials: 'include' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).errorMessages?.[0] || 'The helper is only available to system administrators')
      return (await r.json()) as Explanation
    },
  })
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={tr('Permission helper')} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">{tr('Pick a person and a permission to see whether they have it in')} <strong>{projectKey}</strong> {tr('and why.')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="relative" ref={listRef}>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('User')}</label>
            <input className="veqsio-input w-full" value={user ? user.name : query} onChange={(e) => { setUser(null); setQuery(e.target.value); setListOpen(true) }} onFocus={() => setListOpen(true)} placeholder={tr('Search by name…')} aria-label={tr('User')} />
            {listOpen && !user && q && (found.data?.length ?? 0) > 0 && (
              <ul className="absolute z-20 left-0 right-0 top-full mt-1 max-h-48 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg py-1">
                {found.data!.map((u) => <li key={u.id}><button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--surface-1)]" onClick={() => { setUser({ id: u.id, name: u.name }); setQuery('') }}>{u.name} <span className="text-[var(--text-tertiary)]">({u.key})</span></button></li>)}
              </ul>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Permission')}</label>
            <select className="veqsio-input w-full" value={permission} onChange={(e) => setPermission(e.target.value)}>
              {permissions.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
        </div>
        {result.isLoading && <p className="text-sm text-[var(--text-tertiary)]">{tr('Checking…')}</p>}
        {result.error && <p role="alert" className="text-sm text-[var(--error)]">{(result.error as Error).message}</p>}
        {result.data && (
          <div className="rounded-lg border border-[var(--surface-3)] p-3 space-y-2" aria-live="polite">
            <p className="flex items-center gap-2 font-medium">
              {result.data.allowed ? <CheckCircle2 className="w-5 h-5 text-[var(--success)]" aria-hidden="true" /> : <XCircle className="w-5 h-5 text-[var(--error)]" aria-hidden="true" />}
              {result.data.user.displayName} {result.data.allowed ? 'has' : 'does not have'} {tr('this permission')} </p>
            <ul className="space-y-1 text-sm">
              {result.data.reasons.map((r, i) => <li key={i} className={r.granted ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>{r.granted ? '✓' : '·'} {r.text}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
