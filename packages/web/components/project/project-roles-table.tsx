'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, UserPlus } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { Avatar } from '@/components/avatar'
import { useDebouncedValue } from '@/hooks/use-debounced'
import { useAddProjectRoleActor, useProjectRoles, useRemoveProjectRoleActor, type ProjectRole } from '@/hooks/use-project-admin'

const SHOWN = 4

/** Jira's "Users and roles": one row per project role with its users and groups, an Edit link per role and "Add users to a role". */
export function ProjectRolesTable({ projectKey }: { projectKey: string }) {
  const { data: roles, isLoading } = useProjectRoles(projectKey)
  const add = useAddProjectRoleActor(projectKey)
  const remove = useRemoveProjectRoleActor(projectKey)
  const [editing, setEditing] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  const list = roles ?? []
  const editRole = list.find((r) => r.id === editing) ?? null

  const people = (r: ProjectRole) => r.actors.filter((a) => a.type === 'user' && a.user)
  const groups = (r: ProjectRole) => r.actors.filter((a) => a.type === 'group' && a.group)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-heading-2 text-[var(--text-primary)]">Users and roles</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-3xl">Project roles collect the people and groups who work on this project. Permissions, notifications and issue security are granted to roles, so adding someone to a role is how they get access.</p>
        </div>
        <button type="button" className="veqsio-btn-primary inline-flex items-center gap-1.5" onClick={() => setAddOpen(true)}><UserPlus className="w-4 h-4" aria-hidden="true" />Add users to a role</button>
      </div>

      <div className="rounded-lg border border-[var(--surface-3)] overflow-hidden">
        <table className="w-full text-sm">
          <caption className="sr-only">Project roles</caption>
          <thead><tr className="veqsio-table-header text-left"><th scope="col" className="w-1/4">Project role</th><th scope="col">Users</th><th scope="col" className="w-1/4">Groups</th><th scope="col" className="w-20 text-right"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {list.map((r) => {
              const u = people(r), g = groups(r)
              return (
                <tr key={r.id} className="veqsio-table-row align-top">
                  <td className="px-4 py-3"><div className="font-medium text-[var(--text-primary)]">{r.name}</div>{r.description && <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{r.description}</div>}</td>
                  <td className="px-4 py-3">
                    {u.length === 0 ? <span className="text-[var(--text-tertiary)]">None</span> : (
                      <ul className="space-y-1">
                        {u.slice(0, SHOWN).map((a) => <li key={a.id} className="flex items-center gap-2"><Avatar name={a.user!.displayName} size="sm" />{a.user!.displayName}</li>)}
                        {u.length > SHOWN && <li><button type="button" className="text-xs text-[var(--brand-500)] hover:underline" onClick={() => setEditing(r.id)}>and {u.length - SHOWN} more…</button></li>}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">{g.length === 0 ? <span className="text-[var(--text-tertiary)]">None</span> : <ul className="space-y-1">{g.map((a) => <li key={a.id}>{a.group!.name}</li>)}</ul>}</td>
                  <td className="px-4 py-3 text-right"><button type="button" className="text-[var(--brand-500)] hover:underline inline-flex items-center gap-1" onClick={() => setEditing(r.id)}><Pencil className="w-3.5 h-3.5" aria-hidden="true" />Edit</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!editRole} onClose={() => setEditing(null)} title={editRole ? `Edit “${editRole.name}”` : ''} size="lg">
        {editRole && (
          <div className="space-y-4">
            <ActorPicker onPick={(a) => add.mutate({ roleId: editRole.id, ...(a.type === 'user' ? { userId: a.id } : { groupId: a.id }) }, { onSuccess: () => toast(`${a.name} added`, 'success'), onError: (e) => toast(e.message, 'error') })} />
            <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
              {editRole.actors.length === 0 && <li className="px-4 py-3 text-sm text-[var(--text-tertiary)]">Nobody in this role yet.</li>}
              {editRole.actors.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  {a.type === 'user' ? <Avatar name={a.user?.displayName ?? "?"} size="sm" /> : <span className="w-[22px] text-center text-xs text-[var(--text-tertiary)]">grp</span>}
                  <span className="flex-1">{a.user?.displayName ?? a.group?.name}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">{a.type === 'user' ? a.user?.username : 'group'}</span>
                  <button type="button" aria-label={`Remove ${a.user?.displayName ?? a.group?.name}`} className="p-1 text-[var(--error)] hover:bg-[var(--error)]/10 rounded" onClick={() => remove.mutate({ roleId: editRole.id, user: a.type === 'user' ? a.user?.username : undefined, group: a.type === 'group' ? a.group?.name : undefined }, { onError: (e) => toast(e.message, 'error') })}><Trash2 className="w-4 h-4" /></button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end"><button type="button" className="veqsio-btn-secondary" onClick={() => setEditing(null)}>Close</button></div>
          </div>
        )}
      </Modal>

      <AddUsersDialog isOpen={addOpen} onClose={() => setAddOpen(false)} roles={list} onAdd={async (roleId, picked) => {
        try {
          for (const a of picked) await add.mutateAsync({ roleId, ...(a.type === 'user' ? { userId: a.id } : { groupId: a.id }) })
          toast(`${picked.length} added`, 'success'); setAddOpen(false)
        } catch (e: any) { toast(e?.message || 'Could not add', 'error') }
      }} />
    </div>
  )
}

interface Picked { type: 'user' | 'group'; id: number; name: string }

/** Search users and groups on the server (works with any number of them) and pick one. */
function ActorPicker({ onPick }: { onPick: (a: Picked) => void }) {
  const [type, setType] = useState<'user' | 'group'>('user')
  const [query, setQuery] = useState('')
  const q = useDebouncedValue(query.trim())
  const found = useQuery({
    queryKey: ['role-actor-search', type, q], enabled: q.length > 0,
    queryFn: async (): Promise<Picked[]> => {
      if (type === 'user') { const r = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(q)}`, { credentials: 'include' }); return r.ok ? ((await r.json()) as Array<{ id: number; name: string }>).map((u) => ({ type: 'user', id: u.id, name: u.name })) : [] }
      const r = await fetch(`/rest/api/2/group?query=${encodeURIComponent(q)}&maxResults=10`, { credentials: 'include' })
      return r.ok ? ((await r.json()) as { values: Array<{ id: string; name: string }> }).values.map((g) => ({ type: 'group', id: Number(g.id), name: g.name })) : []
    },
  })
  return (
    <div className="relative flex items-center gap-2">
      <select className="veqsio-input w-28" value={type} onChange={(e) => { setType(e.target.value as 'user' | 'group'); setQuery('') }} aria-label="Add a"><option value="user">User</option><option value="group">Group</option></select>
      <input className="veqsio-input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={type === 'user' ? 'Search users by name…' : 'Search groups…'} aria-label="Search" />
      {q && (found.data?.length ?? 0) > 0 && (
        <ul className="absolute z-20 left-0 right-0 top-full mt-1 max-h-48 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg py-1">
          {found.data!.map((x) => <li key={`${x.type}-${x.id}`}><button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-1)]" onClick={() => { onPick(x); setQuery('') }}><Plus className="w-3.5 h-3.5 text-[var(--brand-500)]" aria-hidden="true" />{x.name}</button></li>)}
        </ul>
      )}
    </div>
  )
}

function AddUsersDialog({ isOpen, onClose, roles, onAdd }: { isOpen: boolean; onClose: () => void; roles: ProjectRole[]; onAdd: (roleId: number, picked: Picked[]) => Promise<void> }) {
  const [roleId, setRoleId] = useState<number | ''>('')
  const [picked, setPicked] = useState<Picked[]>([])
  const role = roleId === '' ? roles[0]?.id : roleId
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add users to a role" size="lg">
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Project role</label>
          <select className="veqsio-input w-full" value={role ?? ''} onChange={(e) => setRoleId(Number(e.target.value))}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Users or groups</label>
          <ActorPicker onPick={(a) => setPicked((cur) => cur.some((x) => x.type === a.type && x.id === a.id) ? cur : [...cur, a])} />
          {picked.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{picked.map((a) => <li key={`${a.type}-${a.id}`} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs">{a.name}<button type="button" aria-label={`Remove ${a.name}`} onClick={() => setPicked((cur) => cur.filter((x) => x !== a))}>×</button></li>)}</ul>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="veqsio-btn-primary disabled:opacity-50" disabled={!role || picked.length === 0} onClick={() => void onAdd(role!, picked).then(() => setPicked([]))}>Add</button>
        </div>
      </div>
    </Modal>
  )
}
