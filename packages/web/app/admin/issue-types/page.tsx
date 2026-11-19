'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'
import { confirmDialog } from '@/components/dialogs'

interface IssueType { id: number; name: string; description: string | null; subtask: boolean; color: string; issueCount: number }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}
const B = '/rest/api/2/admin/issuetype'

function Editor({ type, onDone }: { type: IssueType | null; onDone: () => void }) {
  const [name, setName] = useState(type?.name ?? '')
  const [description, setDescription] = useState(type?.description ?? '')
  const [subtask, setSubtask] = useState(type?.subtask ?? false)
  const [color, setColor] = useState(type?.color ?? '#0052CC')
  const save = useMutation({
    mutationFn: () => api(type ? `${B}/${type.id}` : B, { method: type ? 'PUT' : 'POST', body: JSON.stringify({ name, description: description || null, subtask, color }) }),
    onSuccess: () => { toast('Issue type saved', 'success'); onDone() },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div className="veqsio-card p-4 space-y-3">
      <input className="veqsio-input w-full" aria-label="Name" placeholder="Name, for example Change request" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="veqsio-input w-full" aria-label="Description" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="flex flex-wrap items-center gap-4">
        <label className="text-sm flex items-center gap-2">Colour <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour" /></label>
        <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={subtask} onChange={(e) => setSubtask(e.target.checked)} disabled={!!type && type.issueCount > 0} /> Sub-task type (lives under another issue)</label>
        <span className="text-sm flex items-center gap-2">Preview <IssueTypeGlyph name={name || '?'} color={color} size={20} /></span>
      </div>
      <div className="flex gap-2">
        <button className="veqsio-btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button className="veqsio-btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

export default function IssueTypesPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['admin-issue-types'], queryFn: () => api<{ issueTypes: IssueType[] }>(B).then((r) => r.issueTypes) })
  const [editing, setEditing] = useState<IssueType | 'new' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-issue-types'] }); qc.invalidateQueries({ queryKey: ['issue-types'] }); setEditing(null) }
  const remove = useMutation({ mutationFn: (id: number) => api(`${B}/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: (e: Error) => toast(e.message, 'error') })
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader breadcrumb={[{ label: 'Administration', href: '/admin' }, { label: 'Issue types' }]} title="Issue types" actions={<>{!editing && <button className="veqsio-btn-primary" onClick={() => setEditing('new')}>New issue type</button>}</>} />
        <p className="text-sm text-[var(--text-secondary)]">Create your own types such as Change request or Risk. A new type is offered by projects only after you add it to their issue type scheme (Administration → Issues → Issue type schemes).</p>
        {editing && <Editor type={editing === 'new' ? null : editing} onDone={refresh} />}
        {list.isLoading ? <Spinner /> : list.error ? <p role="alert" className="text-sm text-[var(--error)]">{(list.error as Error).message}</p> : (
          <ul className="veqsio-card divide-y divide-[var(--surface-3)]">
            {(list.data ?? []).map((t) => (
              <li key={t.id} className="flex items-center gap-3 p-3">
                <IssueTypeGlyph name={t.name} color={t.color} size={20} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{t.name}{t.subtask ? ' · sub-task' : ''}</p>
                  <p className="text-sm text-[var(--text-secondary)]">{t.description || 'No description'} · {t.issueCount} issue{t.issueCount === 1 ? '' : 's'}</p>
                </div>
                <button className="veqsio-btn-ghost" onClick={() => setEditing(t)}>Edit</button>
                <button className="veqsio-btn-ghost" disabled={t.issueCount > 0} title={t.issueCount > 0 ? 'Issues still use this type' : undefined} onClick={async () => { if ((await confirmDialog(`Delete issue type "${t.name}"?`))) remove.mutate(t.id) }}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppLayout>
  )
}
