'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useDismiss } from '@/hooks/use-dismiss'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { ChevronDown, Info, Plus, X } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { Modal } from '@/components/modal'
import { PermissionHelperDialog } from '@/components/project/permission-helper-dialog'
import { useDebouncedValue } from '@/hooks/use-debounced'

interface Named { id: number; name: string }
interface Row {
  key: string; name: string; description: string; category: string
  grantedTo: { anyone: boolean; loggedIn: boolean; projectLead: boolean; roles: Array<Named & { members: number }>; groups: Named[]; users: Named[] }
}
interface Response {
  canEdit: boolean; projectId: number
  scheme: { id: number; name: string; description: string | null; usedByProjects: number } | null
  schemes: Named[]; categories: string[]; permissions: Row[]
}
type HolderType = 'role' | 'group' | 'user' | 'projectLead' | 'anyUser' | 'anonymous'
interface Holder { type: HolderType; id?: number }

/** Who may do what in this project (Jira's "Permissions" screen); system administrators can grant and remove here. */
export function ProjectPermissionsPanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const key = ['project-permissions-view', projectKey]
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/permissions`, { credentials: 'include' })
      if (!r.ok) throw new Error(tr('Could not load the permissions'))
      return (await r.json()) as Response
    },
  })
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useDismiss<HTMLDivElement>(actionsOpen, () => setActionsOpen(false))
  const [helperOpen, setHelperOpen] = useState(false)
  const [schemeOpen, setSchemeOpen] = useState(false)
  const [granting, setGranting] = useState<string | null>(null)
  const [scope, setScope] = useState<'project' | 'all'>('project')

  const change = useMutation({
    mutationFn: async (v: { action: 'grant' | 'revoke'; permission: string; holder: Holder }) => {
      const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/permissions/${v.action}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission: v.permission, type: v.holder.type, id: v.holder.id, copyScheme: scope === 'project' }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).errorMessages?.[0] || tr('Could not change the permission'))
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['project-permissions', projectKey] }) },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const useScheme = useMutation({
    mutationFn: async (schemeId: number) => {
      const r = await fetch(`/rest/api/2/permissionscheme/${schemeId}/assign`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: q.data!.projectId }) })
      if (!r.ok) throw new Error(tr('Could not change the scheme'))
    },
    onSuccess: () => { setSchemeOpen(false); toast(tr('Permission scheme changed'), 'success'); void qc.invalidateQueries({ queryKey: key }) },
    onError: (e: Error) => toast(e.message, 'error'),
  })

  if (q.isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (q.error || !q.data) return <p className="text-[var(--error)]">{tr('Could not load the permissions of this project.')}</p>
  const { scheme, categories, permissions, canEdit, schemes } = q.data
  const shared = (scheme?.usedByProjects ?? 0) > 1
  const chip = 'inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-primary)]'

  const remove = (permission: string, holder: Holder, label: string) => canEdit && (
    <button type="button" className="text-[var(--text-tertiary)] hover:text-[var(--error)]" aria-label={tr('Remove {label}', { label })} title={tr('Remove')} onClick={() => change.mutate({ action: 'revoke', permission, holder })}><X className="w-3 h-3" /></button>
  )
  const holders = (r: Row) => {
    const g = r.grantedTo
    const none = !g.anyone && !g.loggedIn && !g.projectLead && !g.roles.length && !g.groups.length && !g.users.length
    return (
      <div className="space-y-1.5">
        {none && <span className="text-[var(--text-tertiary)]">{tr('Nobody')}</span>}
        {g.anyone && <div className="flex items-center gap-1.5"><span className="font-medium">{tr('Anyone')}</span><span className="text-xs text-[var(--warning)]">{tr('(also people who are not signed in)')}</span>{remove(r.key, { type: 'anonymous' }, tr('Anyone'))}</div>}
        {g.loggedIn && <div className="flex items-center gap-1.5"><span className="font-medium">{tr('Any signed-in user')}</span>{remove(r.key, { type: 'anyUser' }, tr('any signed-in user'))}</div>}
        {g.projectLead && <div className="flex items-center gap-1.5"><span className="font-medium">{tr('Project lead')}</span>{remove(r.key, { type: 'projectLead' }, 'project lead')}</div>}
        {g.roles.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-[var(--text-tertiary)] w-20">{tr('Project role')}</span>{g.roles.map((x) => <span key={x.id} className={chip} title={`${x.members} member${x.members === 1 ? '' : 's'} in this project`}>{x.name} <span className="text-[var(--text-tertiary)]">{x.members}</span>{remove(r.key, { type: 'role', id: x.id }, x.name)}</span>)}</div>}
        {g.groups.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-[var(--text-tertiary)] w-20">{tr('Group')}</span>{g.groups.map((x) => <span key={x.id} className={chip}>{x.name}{remove(r.key, { type: 'group', id: x.id }, x.name)}</span>)}</div>}
        {g.users.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-[var(--text-tertiary)] w-20">{tr('User')}</span>{g.users.map((x) => <span key={x.id} className={chip}>{x.name}{remove(r.key, { type: 'user', id: x.id }, x.name)}</span>)}</div>}
        {canEdit && (
          <button type="button" className="inline-flex items-center gap-1 text-xs text-[var(--brand-500)] hover:underline" onClick={() => setGranting(r.key)}><Plus className="w-3 h-3" aria-hidden="true" />{tr('Grant')}</button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Project permissions')}</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-3xl">
            {tr('Permissions define who can see this project and what they may do in it and with its issues. They come from the permission scheme of the project; people get them through project roles, groups or directly. System administrators can always do everything, so “Nobody” means nobody else.')}
          </p>
        </div>
        <div className="relative" ref={actionsRef}>
          <button type="button" className="veqsio-btn-secondary inline-flex items-center gap-1.5" aria-expanded={actionsOpen} onClick={() => setActionsOpen((o) => !o)}>{tr('Actions')} <ChevronDown className="w-4 h-4" aria-hidden="true" /></button>
          {actionsOpen && (
            <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] py-1 shadow-lg">
              <button role="menuitem" className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-1)]" onClick={() => { setActionsOpen(false); setHelperOpen(true) }}>{tr('Permission helper')}</button>
              {canEdit && <button role="menuitem" className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-1)]" onClick={() => { setActionsOpen(false); setSchemeOpen(true) }}>{tr('Use a different scheme')}</button>}
              {canEdit && <Link role="menuitem" className="block px-3 py-2 text-sm hover:bg-[var(--surface-1)]" href="/admin?tab=permissions">{tr('Manage permission schemes')}</Link>}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--surface-3)] bg-[var(--brand-50)] px-4 py-3 text-sm">
        <Info className="w-4 h-4 text-[var(--brand-500)] shrink-0" aria-hidden="true" />
        {scheme ? (<><span>{tr('Scheme used by this project:')} <strong>{scheme.name}</strong></span><span className="text-xs uppercase tracking-wide text-[var(--text-tertiary)]">{tr('used by')} {scheme.usedByProjects === 1 ? tr('{n} project', { n: 1 }) : tr('{n} projects', { n: scheme.usedByProjects })}</span></>) : <span>{tr('This project has no permission scheme yet, so only administrators can use it. The first grant creates one.')}</span>}
        <Link href={`/projects/${projectKey}/settings?tab=people`} className="ml-auto text-[var(--brand-500)] hover:underline">{tr('Users and roles')}</Link>
      </div>

      {canEdit && shared && (
        <fieldset className="rounded-lg border border-[var(--surface-3)] px-4 py-3 text-sm">
          <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{tr('This scheme is shared. Changes apply to')}</legend>
          <label className="mr-6 inline-flex items-center gap-2"><input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> {tr('this project only (a private copy is made)')}</label>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> {tr('all')} {scheme!.usedByProjects} {tr('projects that use it')}</label>
        </fieldset>
      )}

      {categories.map((cat) => {
        const rows = permissions.filter((p) => p.category === cat)
        if (!rows.length) return null
        return (
          <section key={cat} aria-label={cat}>
            <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{cat}</h3>
            <div className="rounded-lg border border-[var(--surface-3)] overflow-hidden">
              <table className="w-full text-sm">
                <caption className="sr-only">{tr('{cat} permissions', { cat })}</caption>
                <thead><tr className="veqsio-table-header text-left"><th scope="col" className="w-1/2">{tr('Permission')}</th><th scope="col">{tr('Granted to')}</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="veqsio-table-row align-top">
                      <td className="px-4 py-3"><div className="font-medium text-[var(--text-primary)]">{r.name}</div><div className="text-xs text-[var(--text-tertiary)] mt-0.5">{r.description}</div></td>
                      <td className="px-4 py-3">{holders(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}

      <PermissionHelperDialog isOpen={helperOpen} onClose={() => setHelperOpen(false)} projectKey={projectKey} permissions={permissions.map((p) => ({ key: p.key, name: p.name }))} />

      <Modal isOpen={schemeOpen} onClose={() => setSchemeOpen(false)} title={tr('Use a different permission scheme')} size="sm">
        <ul className="space-y-1">
          {schemes.map((s) => (
            <li key={s.id}><button type="button" disabled={useScheme.isPending || s.id === scheme?.id} onClick={() => useScheme.mutate(s.id)} className="w-full text-left rounded px-3 py-2 text-sm hover:bg-[var(--surface-1)] disabled:opacity-50">{s.name}{s.id === scheme?.id && <span className="ml-2 text-xs text-[var(--text-tertiary)]">{tr('current')}</span>}</button></li>
          ))}
        </ul>
      </Modal>

      <GrantDialog
        permission={granting ? permissions.find((p) => p.key === granting) ?? null : null}
        projectKey={projectKey}
        onClose={() => setGranting(null)}
        onGrant={(holder) => { change.mutate({ action: 'grant', permission: granting!, holder }); setGranting(null) }}
      />
    </div>
  )
}

function GrantDialog({ permission, projectKey, onClose, onGrant }: { permission: Row | null; projectKey: string; onClose: () => void; onGrant: (h: Holder) => void }) {
  const { tr } = useI18n();

  const [type, setType] = useState<HolderType>('role')
  const [query, setQuery] = useState('')
  const q = useDebouncedValue(query.trim())
  const roles = useQuery({
    queryKey: ['grant-roles', projectKey], enabled: !!permission && type === 'role',
    queryFn: async () => { const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/role`, { credentials: 'include' }); return r.ok ? ((await r.json()) as Named[]) : [] },
  })
  const found = useQuery({
    queryKey: ['grant-search', type, q], enabled: !!permission && (type === 'user' || type === 'group') && q.length > 0,
    queryFn: async () => {
      if (type === 'user') { const r = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(q)}`, { credentials: 'include' }); return r.ok ? ((await r.json()) as Array<{ id: number; name: string }>).map((u) => ({ id: u.id, name: u.name })) : [] }
      const r = await fetch(`/rest/api/2/group?query=${encodeURIComponent(q)}&maxResults=10`, { credentials: 'include' })
      return r.ok ? ((await r.json()) as { values: Array<{ id: string; name: string }> }).values.map((g) => ({ id: Number(g.id), name: g.name })) : []
    },
  })
  const simple = type === 'projectLead' || type === 'anyUser' || type === 'anonymous'
  return (
    <Modal isOpen={!!permission} onClose={onClose} title={permission ? `Grant “${permission.name}”` : ''} size="sm">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Grant to')}</label>
          <select className="veqsio-input w-full" value={type} onChange={(e) => { setType(e.target.value as HolderType); setQuery('') }}>
            <option value="role">{tr('Project role')}</option><option value="group">{tr('Group')}</option><option value="user">{tr('User')}</option>
            <option value="projectLead">{tr('Project lead')}</option><option value="anyUser">{tr('Any signed-in user')}</option><option value="anonymous">{tr('Anyone (no sign-in)')}</option>
          </select>
        </div>
        {simple && <button type="button" className="veqsio-btn-primary" onClick={() => onGrant({ type })}>{tr('Grant')}</button>}
        {type === 'role' && (
          <ul className="max-h-56 overflow-auto">
            {(roles.data ?? []).map((r) => <li key={r.id}><button type="button" className="w-full text-left rounded px-3 py-2 text-sm hover:bg-[var(--surface-1)]" onClick={() => onGrant({ type: 'role', id: r.id })}>{r.name}</button></li>)}
          </ul>
        )}
        {(type === 'user' || type === 'group') && (
          <div>
            <input autoFocus className="veqsio-input w-full" placeholder={type === 'user' ? tr('Search users…') : tr('Search groups…')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={tr('Search')} />
            <ul className="mt-1 max-h-48 overflow-auto">
              {(found.data ?? []).map((x) => <li key={x.id}><button type="button" className="w-full text-left rounded px-3 py-2 text-sm hover:bg-[var(--surface-1)]" onClick={() => onGrant({ type, id: x.id })}>{x.name}</button></li>)}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
