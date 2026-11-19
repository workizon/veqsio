'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { EmptyState } from '@/components/empty-state'
import { ProgressBar } from '@/components/progress-bar'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useMarkReleased, useReleaseNotes, useReleases, type ReleaseVersion } from '@/hooks/use-milestones'
import { progressText } from '@/lib/initiatives'
import { confirmDialog } from '@/components/dialogs'

/** Releases of a project: versions with their issues, progress, release notes and a "Mark released" action. */
export default function ReleasesPage() {
  const key = String(useParams().key)
  const [archived, setArchived] = useState(false)
  const q = useReleases(key, archived)
  const mark = useMarkReleased(key)
  const [open, setOpen] = useState<number | null>(null)

  const release = async (v: ReleaseVersion) => {
    const warn = v.openIssueCount > 0 ? ` ${v.openIssueCount} issue${v.openIssueCount === 1 ? ' is' : 's are'} not done yet.` : ''
    if (!(await confirmDialog(`Mark version ${v.name} as released?${warn}`))) return
    try { await mark.mutateAsync({ id: v.id, releaseDate: v.releaseDate }); toast(`${v.name} released`, 'success') } catch (err: any) { toast(err?.message || 'Could not release the version', 'error') }
  }

  return (
    <AppLayout>
      <div className="space-y-5">
        <Breadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: key, href: `/projects/${key}` }, { label: 'Releases' }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-heading-1 text-[var(--text-primary)]">Releases</h1>
          <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived versions</label>
        </div>
        {q.isLoading && <Spinner />}
        {q.error && <p role="alert" className="text-[var(--error)]">{(q.error as Error).message === 'Not Found' || (q.error as Error).message === 'Not found' ? 'Project not found' : (q.error as Error).message}</p>}
        {q.data && q.data.versions.length === 0 && (
          <EmptyState icon="archive" title="No versions yet" description={q.data.canRelease ? 'Create versions in the project settings, then set the fix version on issues.' : 'A project administrator can create versions in the project settings.'} />
        )}
        <ul className="space-y-3">
          {(q.data?.versions ?? []).map((v) => (
            <li key={v.id} className="veqsio-card space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-heading-3">{v.name}</h2>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.released ? 'bg-[#16A06A1f] text-[#16A06A]' : v.overdue ? 'bg-[#C9372C1f] text-[#C9372C]' : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'}`}>
                  {v.released ? 'Released' : v.overdue ? 'Overdue' : 'Unreleased'}
                </span>
                {v.archived && <span className="text-xs text-[var(--text-tertiary)]">Archived</span>}
                <span className="text-sm text-[var(--text-tertiary)]">{v.releaseDate ? `${v.released ? 'Released' : 'Planned'} ${v.releaseDate}` : 'No release date'}</span>
                <span className="ml-auto flex gap-2">
                  <button type="button" className="veqsio-btn-secondary" aria-expanded={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? 'Hide details' : 'Issues and release notes'}</button>
                  {q.data?.canRelease && !v.released && (
                    <button type="button" className="veqsio-btn-primary flex items-center gap-2" disabled={mark.isPending} onClick={() => release(v)}>{mark.isPending && <Spinner size="sm" />} Mark released</button>
                  )}
                </span>
              </div>
              {v.description && <p className="text-sm text-[var(--text-secondary)]">{v.description}</p>}
              <ProgressBar percent={v.progress.percentDone} label={`Progress of version ${v.name}`} />
              <p className="text-xs text-[var(--text-tertiary)]">{progressText(v.progress)}{v.openIssueCount > 0 ? ` · ${v.openIssueCount} still open` : ''}</p>
              {open === v.id && <ReleaseDetails project={key} version={v} />}
            </li>
          ))}
        </ul>
        {q.data && !q.data.canRelease && q.data.versions.length > 0 && <p className="text-xs text-[var(--text-tertiary)]">Only project administrators can mark a version as released.</p>}
      </div>
    </AppLayout>
  )
}

function ReleaseDetails({ project, version }: { project: string; version: ReleaseVersion }) {
  const notes = useReleaseNotes(project, version.id)
  return (
    <div className="border-t border-[var(--surface-3)] pt-3 grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-medium mb-1">Issues ({version.issues.length})</h3>
        {version.issues.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No issues have this fix version.</p>}
        <ul className="space-y-1">
          {version.issues.map((i) => (
            <li key={i.key} className="flex flex-wrap gap-2 text-sm">
              <Link href={`/issues/${i.key}`} className="font-mono text-[var(--brand-500)] hover:underline">{i.key}</Link>
              <span className="truncate">{i.summary}</span>
              <span className="text-xs text-[var(--text-tertiary)]">{i.status}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-medium mb-1">Release notes</h3>
        {notes.isLoading && <Spinner />}
        {notes.error && <p role="alert" className="text-sm text-[var(--error)]">{(notes.error as Error).message}</p>}
        {notes.data && notes.data.groups.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">Nothing to list.</p>}
        {(notes.data?.groups ?? []).map((g) => (
          <div key={g.type} className="mb-2">
            <p className="text-xs font-medium text-[var(--text-secondary)]">{g.type}</p>
            <ul className="list-disc pl-5 text-sm">{g.issues.map((i) => <li key={i.key}>{i.key} {i.summary}</li>)}</ul>
          </div>
        ))}
        <a className="text-xs text-[var(--brand-500)] hover:underline" href={`/rest/api/2/project/${encodeURIComponent(project)}/versions/${version.id}/release-notes`} target="_blank" rel="noreferrer">Open as Markdown</a>
      </div>
    </div>
  )
}
