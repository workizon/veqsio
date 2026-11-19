'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { usePriorities, useProjectsList } from '@/hooks/use-issues'
import { confirmDialog } from '@/components/dialogs'

interface Scheme { id: number; name: string; description: string | null; defaultPriorityId: number | null; priorityIds: number[]; projects: { id: number; key: string; name: string }[] }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

function Editor({ scheme, onDone }: { scheme: Scheme | null; onDone: () => void }) {
  const prios = usePriorities().data ?? []
  const projects = useProjectsList().data ?? []
  const [name, setName] = useState(scheme?.name ?? '')
  const [ids, setIds] = useState<number[]>(scheme?.priorityIds ?? [])
  const [def, setDef] = useState<number | null>(scheme?.defaultPriorityId ?? null)
  const [projectIds, setProjectIds] = useState<number[]>(scheme?.projects.map((p) => p.id) ?? [])
  const save = useMutation({
    mutationFn: () => api(`/rest/api/2/admin/priorityscheme${scheme ? `/${scheme.id}` : ''}`, {
      method: scheme ? 'PUT' : 'POST',
      body: JSON.stringify({ name, priorityIds: ids, defaultPriorityId: def != null && ids.includes(def) ? def : null, projectIds }),
    }),
    onSuccess: () => { toast('Priority scheme saved', 'success'); onDone() },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div className="veqsio-card p-4 space-y-4">
      <input className="veqsio-input w-full" placeholder="Scheme name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Scheme name" />
      <fieldset>
        <legend className="text-sm font-medium mb-1">Priorities offered</legend>
        <div className="flex flex-wrap gap-3">
          {prios.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={ids.includes(Number(p.id))} onChange={() => setIds(toggle(ids, Number(p.id)))} /> {p.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">Default for new issues
        <select className="veqsio-input block mt-1" value={def ?? ''} onChange={(e) => setDef(e.target.value ? Number(e.target.value) : null)}>
          <option value="">None</option>
          {prios.filter((p) => ids.includes(Number(p.id))).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-medium mb-1">Projects using this scheme</legend>
        <div className="flex flex-wrap gap-3">
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={projectIds.includes(Number(p.id))} onChange={() => setProjectIds(toggle(projectIds, Number(p.id)))} /> {p.key}
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--text-tertiary)] mt-1">A project uses one scheme. Projects without one offer every priority.</p>
      </fieldset>
      <div className="flex gap-2">
        <button className="veqsio-btn-primary" disabled={!name.trim() || ids.length === 0 || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button className="veqsio-btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

export default function PrioritySchemesPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['admin-priority-schemes'], queryFn: () => api<{ schemes: Scheme[] }>('/rest/api/2/admin/priorityscheme').then((r) => r.schemes) })
  const prios = usePriorities().data ?? []
  const [editing, setEditing] = useState<Scheme | 'new' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-priority-schemes'] }); setEditing(null) }
  const remove = useMutation({
    mutationFn: (id: number) => api(`/rest/api/2/admin/priorityscheme/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const name = (id: number) => prios.find((p) => Number(p.id) === id)?.name ?? String(id)
  return (
    <AppLayout>
      <div className=" space-y-4">
        <PageHeader breadcrumb={[{ label: 'Administration', href: '/admin' }, { label: 'Priority schemes' }]} title="Priority schemes" actions={<>{!editing && <button className="veqsio-btn-primary" onClick={() => setEditing('new')}>New scheme</button>}</>} />
        {editing && <Editor key={editing === 'new' ? 'new' : editing.id} scheme={editing === 'new' ? null : editing} onDone={refresh} />}
        {list.isLoading && <Spinner />}
        {list.data?.length === 0 && !editing && <p className="text-sm text-[var(--text-secondary)]">No schemes yet: every project offers every priority.</p>}
        {list.data?.map((s) => (
          <div key={s.id} className="veqsio-card p-4 flex items-start justify-between gap-4">
            <div className="text-sm">
              <div className="font-medium">{s.name}</div>
              <div className="text-[var(--text-secondary)]">{s.priorityIds.map(name).join(', ')}{s.defaultPriorityId ? ` (default: ${name(s.defaultPriorityId)})` : ''}</div>
              <div className="text-[var(--text-tertiary)]">{s.projects.length ? s.projects.map((p) => p.key).join(', ') : 'No projects'}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="veqsio-btn-ghost" onClick={() => setEditing(s)}>Edit</button>
              <button className="veqsio-btn-ghost" onClick={async () => { if ((await confirmDialog(`Delete "${s.name}"? Its projects offer every priority again.`))) remove.mutate(s.id) }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </AppLayout>
  )
}
