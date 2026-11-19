'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useUsers } from '@/hooks/use-users'
import { useProjectsList } from '@/hooks/use-issues'
import { confirmDialog } from '@/components/dialogs'

interface Detail {
  id: number; name: string; description: string | null; leadId: number | null
  members: { id: number; displayName: string }[]; projects: { id: number; key: string; name: string }[]
  hiddenProjects: number; canEdit: boolean; jql: string | null
  stats: { open: number; inProgress: number; doneLast7Days: number; unassigned: number; byMember: { userId: number; open: number }[] }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const inner = (<><p className="text-2xl font-semibold tabular-nums">{value}</p><p className="text-xs text-[var(--text-secondary)]">{label}</p></>)
  return href ? <Link href={href} className="veqsio-card p-3 block no-underline">{inner}</Link> : <div className="veqsio-card p-3">{inner}</div>
}

export default function TeamspacePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['teamspace', id], queryFn: () => api<Detail>(`/rest/api/2/teamspace/${id}`) })
  const users = useUsers().data ?? []
  const allProjects = useProjectsList().data ?? []
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [memberIds, setMemberIds] = useState<number[]>([])
  const [projectIds, setProjectIds] = useState<number[]>([])
  const start = (d: Detail) => { setName(d.name); setDescription(d.description ?? ''); setMemberIds(d.members.map((m) => m.id)); setProjectIds(d.projects.map((p) => p.id)); setEditing(true) }
  const save = useMutation({
    mutationFn: (d: Detail) => api(`/rest/api/2/teamspace/${id}`, { method: 'PUT', body: JSON.stringify({ name, description: description || null, leadId: d.leadId, memberIds, projectIds }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['teamspace', id] }); qc.invalidateQueries({ queryKey: ['teamspaces'] }); setEditing(false); toast('Teamspace saved', 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api(`/rest/api/2/teamspace/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['teamspaces'] }); router.push('/teams') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  if (q.isLoading) return <AppLayout><Spinner /></AppLayout>
  if (q.error || !q.data) return <AppLayout><p role="alert" className="p-6 text-sm text-[var(--error)]">{(q.error as Error)?.message ?? 'Not found'}</p></AppLayout>
  const d = q.data
  const issuesHref = d.jql ? `/issues?jql=${encodeURIComponent(d.jql)}` : undefined
  const openBy = new Map(d.stats.byMember.map((m) => [m.userId, m.open]))
  return (
    <AppLayout>
      <div className="space-y-5">
        <Breadcrumb items={[{ label: 'Teamspaces', href: '/teams' }, { label: d.name }]} />
        {editing ? (
          <div className="veqsio-card p-4 space-y-4">
            <input className="veqsio-input w-full" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            <textarea className="veqsio-input w-full" aria-label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            <fieldset><legend className="text-sm font-medium mb-1">People</legend>
              <div className="flex flex-wrap gap-3 max-h-48 overflow-y-auto">{users.map((u) => <label key={u.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={memberIds.includes(u.id)} onChange={() => setMemberIds(toggle(memberIds, u.id))} />{u.displayName}</label>)}</div>
            </fieldset>
            <fieldset><legend className="text-sm font-medium mb-1">Projects</legend>
              <div className="flex flex-wrap gap-3">{allProjects.map((p) => <label key={p.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={projectIds.includes(Number(p.id))} onChange={() => setProjectIds(toggle(projectIds, Number(p.id)))} />{p.key}</label>)}</div>
            </fieldset>
            <div className="flex gap-2">
              <button className="veqsio-btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate(d)}>Save</button>
              <button className="veqsio-btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="text-heading-1 text-[var(--text-primary)]">{d.name}</h1>
              {d.description && <p className="text-sm text-[var(--text-secondary)] mt-1">{d.description}</p>}
            </div>
            {d.canEdit && <>
              <button className="veqsio-btn-secondary" onClick={() => start(d)}>Edit</button>
              <button className="veqsio-btn-ghost" onClick={async () => { if ((await confirmDialog(`Delete teamspace "${d.name}"? Projects and issues are not affected.`))) remove.mutate() }}>Delete</button>
            </>}
          </div>
        )}
        <section aria-label="Open work" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Open issues" value={d.stats.open} href={issuesHref} />
          <Stat label="In progress" value={d.stats.inProgress} />
          <Stat label="Unassigned" value={d.stats.unassigned} />
          <Stat label="Done in the last 7 days" value={d.stats.doneLast7Days} />
        </section>
        <div className="grid gap-5 sm:grid-cols-2">
          <section>
            <h2 className="text-sm font-medium mb-2">People</h2>
            <ul className="veqsio-card divide-y divide-[var(--surface-3)] text-sm">
              {d.members.map((m) => <li key={m.id} className="flex justify-between px-3 py-2"><span>{m.displayName}{m.id === d.leadId ? ' · lead' : ''}</span><span className="text-[var(--text-secondary)]">{openBy.get(m.id) ?? 0} open</span></li>)}
              {!d.members.length && <li className="px-3 py-2 text-[var(--text-tertiary)]">No people yet.</li>}
            </ul>
          </section>
          <section>
            <h2 className="text-sm font-medium mb-2">Projects</h2>
            <ul className="veqsio-card divide-y divide-[var(--surface-3)] text-sm">
              {d.projects.map((p) => <li key={p.id} className="px-3 py-2"><Link href={`/projects/${p.key}`}>{p.key}</Link> <span className="text-[var(--text-secondary)]">{p.name}</span></li>)}
              {!d.projects.length && <li className="px-3 py-2 text-[var(--text-tertiary)]">No projects yet.</li>}
            </ul>
            {d.hiddenProjects > 0 && <p className="text-xs text-[var(--text-tertiary)] mt-1">{d.hiddenProjects} more project(s) you cannot browse.</p>}
          </section>
        </div>
      </div>
    </AppLayout>
  )
}
