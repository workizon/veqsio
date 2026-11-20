'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useDevData } from '@/hooks/use-application-links'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { GitCommit, GitBranch, GitPullRequest, ExternalLink, RefreshCw, Code } from 'lucide-react'

export function DevelopmentPanel({ issueKey }: { issueKey: string }) {
  const { tr } = useI18n();

  const { data, isLoading } = useDevData(issueKey)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  const commits = data?.commits || []
  const branches = data?.branches || []
  const prs = data?.pullRequests || []

  const hasData = commits.length > 0 || branches.length > 0 || prs.length > 0

  if (!hasData) {
    return (
      <EmptyState
        icon={Code}
        title={tr('No development data')}
        description={
          <>
            {tr('Configure')} <strong>{tr('Application links')}</strong> {tr('in System Administration to connect with GitHub, GitLab, or Bitbucket and see commits, branches, and pull requests here.')} </>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Commits */}
      {commits.length > 0 && (
        <div>
          <h3 className="text-body-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
            <GitCommit className="w-4 h-4 text-[var(--text-tertiary)]" />
            {tr('Commits (')}{commits.length})
          </h3>
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {commits.map((commit) => (
              <div key={commit.id} className="px-4 py-3 hover:bg-[var(--surface-1)] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm text-[var(--text-primary)] truncate">{commit.message}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-caption text-[var(--text-tertiary)]">
                      <span className="font-mono">{commit.commitId.slice(0, 7)}</span>
                      {commit.authorName && <span>{commit.authorName}</span>}
                      {commit.branch && <span>{commit.branch}</span>}
                      {commit.committedAt && (
                        <span>{new Date(commit.committedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  {commit.url && (
                    <a href={commit.url} target="_blank" rel="noreferrer" className="text-[var(--brand-500)] hover:text-[var(--brand-600)] flex-shrink-0 mt-0.5">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Branches */}
      {branches.length > 0 && (
        <div>
          <h3 className="text-body-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
            <GitBranch className="w-4 h-4 text-[var(--text-tertiary)]" />
            {tr('Branches (')}{branches.length})
          </h3>
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {branches.map((branch) => (
              <div key={branch.id} className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-[var(--surface-1)] transition-colors">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-body-sm font-medium text-[var(--text-primary)]">{branch.name}</span>
                    {branch.isDefault && <span className="text-caption px-1.5 py-0.5 bg-[var(--brand-500)] text-white rounded-full">{tr('default')}</span>}
                  </div>
                  {(branch.aheadBy || branch.behindBy) && (
                    <div className="text-caption text-[var(--text-tertiary)] mt-0.5">
                      {branch.aheadBy ? `${branch.aheadBy} ahead` : ''}
                      {branch.aheadBy && branch.behindBy ? ' · ' : ''}
                      {branch.behindBy ? `${branch.behindBy} behind` : ''}
                    </div>
                  )}
                </div>
                {branch.url && (
                  <a href={branch.url} target="_blank" rel="noreferrer" className="text-[var(--brand-500)] hover:text-[var(--brand-600)] flex-shrink-0">
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pull Requests */}
      {prs.length > 0 && (
        <div>
          <h3 className="text-body-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
            <GitPullRequest className="w-4 h-4 text-[var(--text-tertiary)]" />
            {tr('Pull Requests (')}{prs.length})
          </h3>
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {prs.map((pr) => (
              <div key={pr.id} className="px-4 py-3 hover:bg-[var(--surface-1)] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body-sm font-medium text-[var(--text-primary)]">{pr.title}</span>
                      <span className={`text-caption px-1.5 py-0.5 rounded-full ${
                        pr.status === 'open' ? 'bg-green-500/10 text-green-600' :
                        pr.status === 'merged' ? 'bg-purple-500/10 text-purple-600' :
                        'bg-[var(--surface-3)] text-[var(--text-tertiary)]'
                      }`}>
                        {pr.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-caption text-[var(--text-tertiary)]">
                      <span>#{pr.prId}</span>
                      {pr.authorName && <span>{pr.authorName}</span>}
                      {pr.sourceBranch && pr.targetBranch && (
                        <span>{pr.sourceBranch} → {pr.targetBranch}</span>
                      )}
                      {pr.updatedAt && (
                        <span>{tr('Updated')} {new Date(pr.updatedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  {pr.url && (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="text-[var(--brand-500)] hover:text-[var(--brand-600)] flex-shrink-0 mt-0.5">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
