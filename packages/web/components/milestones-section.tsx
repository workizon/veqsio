'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ProgressBar } from '@/components/progress-bar'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useCreateMilestone, useDeleteMilestone, useLinkMilestoneIssue, useMilestone, useMilestones, useUnlinkMilestoneIssue, useUpdateMilestone, type Milestone } from '@/hooks/use-milestones'
import { progressText } from '@/lib/initiatives'
import { confirmDialog } from '@/components/dialogs'

/** Milestones of a project: list with progress, expandable issue list, and (for project admins) create, mark reached and delete. */
export function MilestonesSection({ project }: { project: string }) {
  const { data, isLoading, error } = useMilestones(project)
  const create = useCreateMilestone(project)
  const update = useUpdateMilestone(project)
  const del = useDeleteMilestone(project)
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const canManage = !!data?.canManage

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try { await create.mutateAsync({ name: name.trim(), targetDate: date || null }); setName(''); setDate(''); toast('Milestone created', 'success') } catch (err: any) { toast(err?.message || 'Could not create the milestone', 'error') }
  }
  const run = async (p: Promise<unknown>, ok: string) => { try { await p; toast(ok, 'success') } catch (err: any) { toast(err?.message || 'Failed', 'error') } }

  return (
    <section aria-labelledby={`ms-${project}`} className="space-y-4">
      <h2 id={`ms-${project}`} className="text-heading-3 text-[var(--text-primary)]">Milestones</h2>
      {canManage && (
        <form onSubmit={submit} className="veqsio-card flex flex-wrap items-end gap-3" aria-label="New milestone">
          <label className="text-sm block">Name<input className="veqsio-input block" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="text-sm block">Target date<input type="date" className="veqsio-input block" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="submit" className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50" disabled={!name.trim() || create.isPending}>{create.isPending && <Spinner size="sm" />} Add milestone</button>
        </form>
      )}
      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-sm text-[var(--error)]">{(error as Error).message}</p>}
      {data && data.milestones.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No milestones yet.{canManage ? ' Add the first one above, then link issues to it from the issue sidebar.' : ''}</p>}
      <ul className="space-y-3">
        {(data?.milestones ?? []).map((m) => (
          <li key={m.id} className="veqsio-card space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" className="font-medium text-[var(--brand-500)] hover:underline" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>{m.name}</button>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.state === 'reached' ? 'bg-[#16A06A1f] text-[#16A06A]' : m.overdue ? 'bg-[#C9372C1f] text-[#C9372C]' : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'}`}>
                {m.state === 'reached' ? 'Reached' : m.overdue ? 'Overdue' : 'Open'}
              </span>
              <span className="text-[var(--text-tertiary)]">{m.targetDate ? `Target ${m.targetDate}` : 'No target date'}</span>
              {canManage && (
                <span className="ml-auto flex gap-3">
                  <button type="button" className="text-xs text-[var(--brand-500)] hover:underline" onClick={() => run(update.mutateAsync({ id: m.id, patch: { state: m.state === 'reached' ? 'open' : 'reached' } }), m.state === 'reached' ? 'Reopened' : 'Marked as reached')}>{m.state === 'reached' ? 'Reopen' : 'Mark reached'}</button>
                  <button type="button" className="text-xs text-[var(--error)] hover:underline" aria-label={`Delete milestone ${m.name}`} onClick={async () => { if ((await confirmDialog(`Delete the milestone "${m.name}"? The issues are kept.`))) run(del.mutateAsync(m.id), 'Milestone deleted') }}>Delete</button>
                </span>
              )}
            </div>
            <ProgressBar percent={m.progress.percentDone} label={`Progress of milestone ${m.name}`} />
            <p className="text-xs text-[var(--text-tertiary)]">{progressText(m.progress)}</p>
            {open === m.id && <MilestoneIssues project={project} milestone={m} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

function MilestoneIssues({ project, milestone }: { project: string; milestone: Milestone }) {
  const detail = useMilestone(project, milestone.id)
  const link = useLinkMilestoneIssue(project)
  const unlink = useUnlinkMilestoneIssue(project)
  const [key, setKey] = useState('')
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim()) return
    try { await link.mutateAsync({ id: milestone.id, issueKey: key.trim() }); setKey('') } catch (err: any) { toast(err?.message || 'Could not link the issue', 'error') }
  }
  return (
    <div className="border-t border-[var(--surface-3)] pt-2 space-y-2">
      {detail.isLoading && <Spinner />}
      {detail.data && detail.data.issues?.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No issues linked yet.</p>}
      <ul className="space-y-1">
        {(detail.data?.issues ?? []).map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-2 text-sm">
            <Link href={`/issues/${i.key}`} className="font-mono text-[var(--brand-500)] hover:underline">{i.key}</Link>
            <span className="truncate">{i.summary}</span>
            <span className="text-xs text-[var(--text-tertiary)]">{i.status}</span>
            <button type="button" className="ml-auto text-xs text-[var(--error)] hover:underline" aria-label={`Remove ${i.key} from ${milestone.name}`} onClick={() => unlink.mutate({ id: milestone.id, issueKey: i.key })}>Remove</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex items-end gap-2">
        <label className="text-sm block">Add issue by key<input className="veqsio-input block" placeholder={`${project}-1`} value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <button type="submit" className="veqsio-btn-secondary" disabled={!key.trim() || link.isPending}>Add</button>
      </form>
    </div>
  )
}
