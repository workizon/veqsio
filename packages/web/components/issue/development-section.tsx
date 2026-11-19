'use client'

import { useState } from 'react'
import { GitBranch, GitCommit, GitPullRequest } from 'lucide-react'
import { toast } from '@/components/toast'
import { useCreateBranch, useDevelopment, type DevLink } from '@/hooks/use-scm'

const BUILD: Record<string, string> = { success: 'Build passed', failed: 'Build failed', pending: 'Build running' }
const PR_STYLE: Record<string, string> = { open: 'text-[var(--brand-500)]', merged: 'text-[var(--success)]', closed: 'text-[var(--text-tertiary)]' }

function Row({ icon, link, label }: { icon: React.ReactNode; link: DevLink; label: string }) {
  return (
    <li className="flex items-center gap-2 text-body-sm min-w-0">
      <span className="text-[var(--text-tertiary)] shrink-0" aria-hidden="true">{icon}</span>
      {link.url ? <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-[var(--brand-500)] hover:underline truncate">{label}</a> : <span className="truncate">{label}</span>}
      <span className="text-caption text-[var(--text-tertiary)] shrink-0">{link.repository}</span>
      {link.status && <span className={`text-caption font-medium ${PR_STYLE[link.status] ?? ''}`}>{link.status}</span>}
      {link.buildStatus && <span className={`text-caption ${link.buildStatus === 'failed' ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>{BUILD[link.buildStatus] ?? link.buildStatus}</span>}
    </li>
  )
}

/** "Development" panel: branches, commits and pull requests found by key, plus "Create branch". Hidden when there is nothing to show. */
export function DevelopmentSection({ issueKey }: { issueKey: string }) {
  const dev = useDevelopment(issueKey)
  const create = useCreateBranch(issueKey)
  const [repoId, setRepoId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const d = dev.data
  if (!d) return null
  const empty = !d.branches.length && !d.commits.length && !d.pullRequests.length
  const creatable = d.canCreateBranch ? d.repositories.filter((r) => r.canCreateBranch) : []
  if (empty && !d.repositories.length) return null

  const submit = async () => {
    const id = repoId ?? creatable[0]?.id
    if (!id) return
    try {
      const res = await create.mutateAsync({ repositoryId: id, name: name.trim() || undefined })
      toast(`Created branch ${res.branch}`, 'success')
      setOpen(false); setName('')
    } catch (e: any) {
      toast(e?.message || 'Failed to create the branch', 'error')
    }
  }

  return (
    <section aria-labelledby="dev-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="dev-heading" className="text-heading-3 text-[var(--text-primary)]">Development</h2>
        {creatable.length > 0 && <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setOpen((v) => !v)}>Create branch</button>}
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--surface-3)] p-3">
          {creatable.length > 1 && (
            <select aria-label="Repository" className="veqsio-input !w-auto" value={repoId ?? creatable[0].id} onChange={(e) => setRepoId(Number(e.target.value))}>
              {creatable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <input aria-label="Branch name" className="veqsio-input flex-1 min-w-[220px]" placeholder={d.suggestedBranch} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="veqsio-btn-primary text-sm" disabled={create.isPending} onClick={() => void submit()}>Create</button>
        </div>
      )}
      {empty ? <p className="text-body-sm text-[var(--text-tertiary)]">No branches, commits or pull requests yet. Include {issueKey} in a branch name, commit message or pull request title.</p> : (
        <ul className="space-y-1.5">
          {d.pullRequests.map((l) => <Row key={`pr-${l.id}`} icon={<GitPullRequest className="w-4 h-4" />} link={l} label={`#${l.ref} ${l.title ?? ''}`} />)}
          {d.branches.map((l) => <Row key={`b-${l.id}`} icon={<GitBranch className="w-4 h-4" />} link={l} label={l.ref} />)}
          {d.commits.slice(0, 10).map((l) => <Row key={`c-${l.id}`} icon={<GitCommit className="w-4 h-4" />} link={l} label={`${l.ref.slice(0, 7)} ${l.title ?? ''}`} />)}
        </ul>
      )}
    </section>
  )
}
