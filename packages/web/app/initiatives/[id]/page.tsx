'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { ProgressBar } from '@/components/progress-bar'
import { Spinner } from '@/components/spinner'
import { StatusUpdateBadge } from '@/components/status-update-badge'
import { StatusUpdatesPanel } from '@/components/status-updates-panel'
import { toast } from '@/components/toast'
import { useFeatures } from '@/hooks/use-features'
import { useDeleteInitiative, useInitiative, useLinkInitiative, useUnlinkInitiative, useUpdateInitiative } from '@/hooks/use-initiatives'
import { INITIATIVE_STATUS_OPTIONS, dateRangeText, initiativeStatusBadge, progressText, timelineStrip, type InitiativeStatus } from '@/lib/initiatives'
import { confirmDialog } from '@/components/dialogs'

const STRIP_COLOR = { 'no-dates': '#667085', 'not-started': '#667085', 'in-progress': '#2D54D8', overdue: '#C9372C', finished: '#16A06A' } as const

export default function InitiativePage() {
  const params = useParams()
  const id = String(params.id)
  const router = useRouter()
  const features = useFeatures()
  const q = useInitiative(id)
  const update = useUpdateInitiative(Number(id))
  const del = useDeleteInitiative(Number(id))
  const link = useLinkInitiative(Number(id))
  const unlink = useUnlinkInitiative(Number(id))
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await fetch('/rest/api/2/project', { credentials: 'include' })).json() as Promise<Array<{ key: string; name: string }>>,
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', status: 'planned' as InitiativeStatus, startDate: '', targetDate: '' })
  const [epicKey, setEpicKey] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const i = q.data

  const startEdit = () => {
    if (!i) return
    setDraft({ name: i.name, description: i.description, status: i.status, startDate: i.startDate ?? '', targetDate: i.targetDate ?? '' })
    setEditing(true)
  }
  const dateProblem = draft.startDate && draft.targetDate && draft.targetDate < draft.startDate ? 'The target date must not be before the start date' : null
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (dateProblem || !draft.name.trim()) return
    try {
      await update.mutateAsync({ name: draft.name.trim(), description: draft.description, status: draft.status, startDate: draft.startDate || null, targetDate: draft.targetDate || null })
      setEditing(false)
      toast('Initiative saved', 'success')
    } catch (err: any) { toast(err?.message || 'Could not save', 'error') }
  }
  const addLink = async (v: { issueKey?: string; projectKey?: string }, reset: () => void) => {
    try { await link.mutateAsync(v); reset(); toast('Linked', 'success') } catch (err: any) { toast(err?.message || 'Could not link', 'error') }
  }
  const remove = async () => {
    if (!i || !(await confirmDialog(`Delete the initiative "${i.name}"? Epics and projects are not deleted.`))) return
    try { await del.mutateAsync(); toast('Initiative deleted', 'success'); router.push('/initiatives') } catch (err: any) { toast(err?.message || 'Could not delete', 'error') }
  }

  const strip = i ? timelineStrip(i.startDate, i.targetDate, i.status) : null
  const badge = i ? initiativeStatusBadge(i.status) : null
  const linkedProjectKeys = new Set((i?.projects ?? []).map((p) => p.key))

  return (
    <AppLayout>
      <div className="space-y-6 max-w-4xl">
        <Breadcrumb items={[{ label: 'Initiatives', href: '/initiatives' }, { label: i?.name ?? '…' }]} />
        {q.isLoading && <Spinner />}
        {q.error && <p role="alert" className="text-[var(--error)]">{(q.error as Error).message === 'Not Found' || (q.error as Error).message === 'Not found' ? 'Initiative not found' : (q.error as Error).message}</p>}

        {i && badge && strip && (
          <>
            <header className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-heading-1 text-[var(--text-primary)]">{i.name}</h1>
                <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${badge.color}1f`, color: badge.color }}>{badge.label}</span>
                {i.health && <StatusUpdateBadge state={i.health.state} title="Latest health update" />}
                {i.canManage && (
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="veqsio-btn-secondary" onClick={startEdit}>Edit</button>
                    <button type="button" className="veqsio-btn-secondary text-[var(--error)]" onClick={remove}>Delete</button>
                  </span>
                )}
              </div>
              <p className="text-sm text-[var(--text-secondary)]">{i.owner ? `Owner: ${i.owner.displayName} · ` : ''}{dateRangeText(i.startDate, i.targetDate)}</p>
              {i.description && <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">{i.description}</p>}
            </header>

            {editing && (
              <form onSubmit={save} className="veqsio-card space-y-3" aria-label="Edit initiative">
                <label className="text-sm block">Name<input className="veqsio-input block w-full" value={draft.name} maxLength={255} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
                <label className="text-sm block">Description<textarea className="veqsio-input block w-full" rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm block">Status
                    <select className="veqsio-input block w-full" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as InitiativeStatus })}>
                      {INITIATIVE_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="text-sm block">Start date<input type="date" className="veqsio-input block w-full" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} /></label>
                  <label className="text-sm block">Target date<input type="date" className="veqsio-input block w-full" value={draft.targetDate} onChange={(e) => setDraft({ ...draft, targetDate: e.target.value })} /></label>
                </div>
                {dateProblem && <p role="alert" className="text-sm text-[var(--error)]">{dateProblem}</p>}
                <div className="flex gap-2">
                  <button type="submit" className="veqsio-btn-primary disabled:opacity-50" disabled={!!dateProblem || update.isPending}>Save</button>
                  <button type="button" className="veqsio-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </form>
            )}

            <section aria-labelledby="init-progress" className="veqsio-card space-y-3">
              <h2 id="init-progress" className="text-heading-3">Progress</h2>
              <ProgressBar percent={i.progress.percentDone} label={`Progress of ${i.name}`} />
              <p className="text-sm text-[var(--text-secondary)]">{progressText(i.progress)}. Counted over the child issues of the linked epics and the issues of the linked projects you can see; cancelled issues are left out.</p>
              <div>
                <div className="flex justify-between text-xs text-[var(--text-tertiary)] mb-1">
                  <span>{i.startDate ?? 'Start'}</span><span>{strip.label}</span><span>{i.targetDate ?? 'Target'}</span>
                </div>
                <div className="relative h-3 rounded-full bg-[var(--surface-3)]" role="img" aria-label={`Timeline: ${strip.label}`}>
                  <div className="absolute inset-y-0 left-0 rounded-full opacity-40" style={{ width: `${strip.elapsedPct}%`, background: STRIP_COLOR[strip.state] }} />
                  {strip.todayPct !== null && <div className="absolute -top-1 -bottom-1 w-0.5" style={{ left: `${strip.todayPct}%`, background: STRIP_COLOR[strip.state] }} title="Today" />}
                </div>
              </div>
            </section>

            <section aria-labelledby="init-epics" className="space-y-3">
              <h2 id="init-epics" className="text-heading-3">Linked epics ({i.epicCount})</h2>
              {i.canManage && (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (epicKey.trim()) addLink({ issueKey: epicKey.trim() }, () => setEpicKey('')) }}>
                  <label className="text-sm block">Add an epic by key<input className="veqsio-input block" placeholder="PROJ-12" value={epicKey} onChange={(e) => setEpicKey(e.target.value)} /></label>
                  <button type="submit" className="veqsio-btn-secondary" disabled={!epicKey.trim() || link.isPending}>Link epic</button>
                </form>
              )}
              {(i.epics ?? []).length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No epics linked.</p>}
              <ul className="space-y-2">
                {(i.epics ?? []).map((e) => (
                  <li key={e.key} className="veqsio-card space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Link href={`/issues/${e.key}`} className="font-mono text-[var(--brand-500)] hover:underline">{e.key}</Link>
                      <span className="truncate">{e.summary}</span>
                      <span className="text-[var(--text-tertiary)]">{e.project.key} · {e.status}</span>
                      {i.canManage && <button type="button" className="ml-auto text-xs text-[var(--error)] hover:underline" aria-label={`Unlink ${e.key}`} onClick={() => unlink.mutate({ kind: 'epics', key: e.key })}>Unlink</button>}
                    </div>
                    <ProgressBar percent={e.progress.percentDone} label={`Progress of ${e.key}`} />
                    <p className="text-xs text-[var(--text-tertiary)]">{progressText(e.progress)}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="init-projects" className="space-y-3">
              <h2 id="init-projects" className="text-heading-3">Linked projects ({i.projectCount})</h2>
              {i.canManage && (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (projectKey) addLink({ projectKey }, () => setProjectKey('')) }}>
                  <label className="text-sm block">Add a project
                    <select className="veqsio-input block" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
                      <option value="">Choose…</option>
                      {(projects.data ?? []).filter((p) => !linkedProjectKeys.has(p.key)).map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                    </select>
                  </label>
                  <button type="submit" className="veqsio-btn-secondary" disabled={!projectKey || link.isPending}>Link project</button>
                </form>
              )}
              {(i.projects ?? []).length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No projects linked.</p>}
              <ul className="space-y-2">
                {(i.projects ?? []).map((p) => (
                  <li key={p.key} className="veqsio-card space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Link href={`/projects/${p.key}`} className="font-medium text-[var(--brand-500)] hover:underline">{p.key} — {p.name}</Link>
                      {i.canManage && <button type="button" className="ml-auto text-xs text-[var(--error)] hover:underline" aria-label={`Unlink project ${p.key}`} onClick={() => unlink.mutate({ kind: 'projects', key: p.key })}>Unlink</button>}
                    </div>
                    <ProgressBar percent={p.progress.percentDone} label={`Progress of project ${p.key}`} />
                    <p className="text-xs text-[var(--text-tertiary)]">{progressText(p.progress)}</p>
                  </li>
                ))}
              </ul>
            </section>

            {features.isEnabled('updates') && <StatusUpdatesPanel scope={id} initiative canPost={i.canManage} />}
          </>
        )}
      </div>
    </AppLayout>
  )
}
