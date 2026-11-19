'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { EmptyState } from '@/components/empty-state'
import { ProgressBar } from '@/components/progress-bar'
import { Spinner } from '@/components/spinner'
import { StatusUpdateBadge } from '@/components/status-update-badge'
import { toast } from '@/components/toast'
import { useFeatures } from '@/hooks/use-features'
import { useCreateInitiative, useInitiatives } from '@/hooks/use-initiatives'
import { INITIATIVE_STATUS_OPTIONS, dateRangeText, initiativeStatusBadge, progressText, type InitiativeStatus } from '@/lib/initiatives'

export default function InitiativesPage() {
  const router = useRouter()
  const features = useFeatures()
  const on = features.isEnabled('initiatives')
  const list = useInitiatives(on)
  const create = useCreateInitiative()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [status, setStatus] = useState<InitiativeStatus>('planned')
  const [startDate, setStart] = useState('')
  const [targetDate, setTarget] = useState('')
  const [filter, setFilter] = useState<'all' | InitiativeStatus>('all')
  const dateProblem = startDate && targetDate && targetDate < startDate ? 'The target date must not be before the start date' : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || dateProblem) return
    try {
      const created = (await create.mutateAsync({ name: name.trim(), status, startDate: startDate || null, targetDate: targetDate || null }))  as { id: number }
      toast('Initiative created', 'success')
      router.push(`/initiatives/${created.id}`)
    } catch (err: any) {
      toast(err?.message || 'Could not create the initiative', 'error')
    }
  }

  const shown = (list.data ?? []).filter((i) => filter === 'all' || i.status === filter)

  return (
    <AppLayout>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-heading-1 text-[var(--text-primary)]">Initiatives</h1>
            <p className="text-body-sm text-[var(--text-secondary)]">Group epics and projects into one goal and follow its progress.</p>
          </div>
          {on && <button type="button" className="veqsio-btn-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>New initiative</button>}
        </div>

        {!on && <p role="status" className="text-[var(--text-tertiary)]">Initiatives are switched off on this instance.</p>}

        {on && open && (
          <form onSubmit={submit} className="veqsio-card space-y-3" aria-label="New initiative">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm block sm:col-span-2">Name
                <input className="veqsio-input block w-full" value={name} maxLength={255} required onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <label className="text-sm block">Status
                <select className="veqsio-input block w-full" value={status} onChange={(e) => setStatus(e.target.value as InitiativeStatus)}>
                  {INITIATIVE_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm block">Start date<input type="date" className="veqsio-input block w-full" value={startDate} onChange={(e) => setStart(e.target.value)} /></label>
                <label className="text-sm block">Target date<input type="date" className="veqsio-input block w-full" value={targetDate} onChange={(e) => setTarget(e.target.value)} /></label>
              </div>
            </div>
            {dateProblem && <p role="alert" className="text-sm text-[var(--error)]">{dateProblem}</p>}
            <p className="text-caption text-[var(--text-tertiary)]">You become the owner. Link epics and projects on the next page.</p>
            <button type="submit" className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50" disabled={!name.trim() || !!dateProblem || create.isPending}>
              {create.isPending && <Spinner size="sm" />} Create initiative
            </button>
          </form>
        )}

        {on && (
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {[{ value: 'all', label: 'All' }, ...INITIATIVE_STATUS_OPTIONS].map((o) => (
              <button key={o.value} type="button" aria-pressed={filter === o.value} className={filter === o.value ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => setFilter(o.value as any)}>{o.label}</button>
            ))}
          </div>
        )}

        {on && list.isLoading && <Spinner />}
        {list.error && <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p>}
        {on && list.data && shown.length === 0 && (
          <EmptyState icon="folder" title={filter === 'all' ? 'No initiatives yet' : 'No initiatives with this status'} description={filter === 'all' ? 'Create one to group epics and projects. You only see initiatives that contain something you can browse, or that you own.' : undefined} />
        )}

        {shown.length > 0 && (
          <ul className="space-y-3">
            {shown.map((i) => {
              const b = initiativeStatusBadge(i.status)
              return (
                <li key={i.id} className="veqsio-card space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <Link href={`/initiatives/${i.id}`} className="text-heading-3 text-[var(--brand-500)] hover:underline">{i.name}</Link>
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${b.color}1f`, color: b.color }}>{b.label}</span>
                    {i.health && <StatusUpdateBadge state={i.health.state} title="Latest health update" />}
                  </div>
                  <ProgressBar percent={i.progress.percentDone} label={`Progress of ${i.name}`} />
                  <p className="text-sm text-[var(--text-secondary)]">
                    {progressText(i.progress)} · {i.epicCount} epic{i.epicCount === 1 ? '' : 's'}, {i.projectCount} project{i.projectCount === 1 ? '' : 's'} · {dateRangeText(i.startDate, i.targetDate)}
                    {i.owner ? ` · Owner: ${i.owner.displayName}` : ''}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </AppLayout>
  )
}
