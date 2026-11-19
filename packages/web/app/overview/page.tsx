'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { ArrowUpRight, CircleDot, Clock3, CheckCircle2, AlertCircle, KanbanSquare, FolderKanban, List } from 'lucide-react'

interface SearchResponse {
  total: number
  issues: Array<{
    id: string
    key: string
    fields: {
      summary: string
      status?: { name: string }
      priority?: { name: string }
      updated: string
    }
  }>
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

function useDashboardStat(jql: string) {
  return useQuery({
    queryKey: ['dashboard-stat', jql],
    queryFn: () =>
      fetchJson<SearchResponse>(
        `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=0`
      ),
  })
}

function useRecentIssues() {
  return useQuery({
    queryKey: ['dashboard-recent-issues'],
    queryFn: () =>
      fetchJson<SearchResponse>(
        `/rest/api/2/search?jql=${encodeURIComponent('ORDER BY updated DESC')}&maxResults=5&fields=summary,status,priority`
      ),
  })
}

function StatSkeleton() {
  return (
    <div className="veqsio-card animate-pulse">
      <div className="h-4 w-24 bg-[var(--surface-2)] rounded mb-2" />
      <div className="h-8 w-12 bg-[var(--surface-2)] rounded" />
    </div>
  )
}

function IssueSkeleton() {
  return (
    <div className="veqsio-table-row rounded-lg animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-4 w-16 bg-[var(--surface-2)] rounded" />
        <div className="h-4 w-48 bg-[var(--surface-2)] rounded" />
        <div className="h-5 w-20 bg-[var(--surface-2)] rounded-full ml-auto" />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const open = useDashboardStat(
    'status not in (Done, Closed, Resolved)'
  )
  const inProgress = useDashboardStat(
    'status = "In Progress"'
  )
  const done = useDashboardStat(
    'status in (Done, Closed, Resolved) AND updated >= -7d'
  )
  const overdue = useDashboardStat(
    'duedate < now() AND status not in (Done, Closed, Resolved)'
  )
  const { data: recentData, isLoading: recentLoading, error: recentError } =
    useRecentIssues()

  const stats = [
    { label: 'Open issues', hint: 'Ready for the next step', icon: CircleDot, query: open, color: 'var(--text-primary)' },
    { label: 'In progress', hint: 'Work moving forward', icon: Clock3, query: inProgress, color: 'var(--brand-600)' },
    { label: 'Done this week', hint: 'Updated in the last 7 days', icon: CheckCircle2, query: done, color: 'var(--success)' },
    { label: 'Overdue', hint: 'Needs your attention', icon: AlertCircle, query: overdue, color: 'var(--error)' },
  ]

  return (
    <AppLayout>
      <div className="space-y-8 py-2 sm:py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-caption text-[var(--text-tertiary)] mb-2">WORKSPACE OVERVIEW</p>
            <h1 className="text-heading-1 text-[var(--text-primary)]">Your work, at a glance</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-2">Keep track of progress and find your next focus.</p>
          </div>
          <Link href="/issues" className="veqsio-btn-secondary">Browse issues <ArrowUpRight className="w-4 h-4" aria-hidden="true" /></Link>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {stats.map(({ label, hint, icon: Icon, query, color }) => query.isLoading ? <StatSkeleton key={label} /> : (
            <div key={label} className="veqsio-card p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-[var(--text-secondary)]">{label}</p>
                <Icon className="w-4 h-4" style={{ color }} aria-hidden="true" />
              </div>
              <p className="text-4xl font-semibold tracking-tight tabular-nums mt-5" style={{ color }}>{query.isError ? '—' : query.data?.total ?? 0}</p>
              {query.isError ? <button onClick={() => void query.refetch()} className="text-xs text-[var(--error)] mt-3 hover:underline">Unable to load · Retry</button> : <p className="text-xs text-[var(--text-tertiary)] mt-3">{hint}</p>}
            </div>
          ))}
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          {[
            { href: '/boards', icon: KanbanSquare, title: 'Boards', description: 'See work in motion' },
            { href: '/projects', icon: FolderKanban, title: 'Projects', description: 'Find your team’s workspace' },
            { href: '/backlog', icon: List, title: 'Backlog', description: 'Plan what comes next' },
          ].map(({ href, icon: Icon, title, description }) => (
            <Link key={href} href={href} className="group flex items-center gap-3 rounded-xl border border-[var(--surface-3)] p-4 hover:bg-[var(--surface-0)] hover:border-[var(--surface-4)] transition-colors">
              <div className="p-2 rounded-lg bg-[var(--surface-2)]"><Icon className="w-5 h-5 text-[var(--text-secondary)]" aria-hidden="true" /></div>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium text-[var(--text-primary)]">{title}</p><p className="text-xs text-[var(--text-tertiary)] mt-1">{description}</p></div>
              <ArrowUpRight className="w-4 h-4 text-[var(--text-tertiary)] group-hover:text-[var(--brand-600)]" aria-hidden="true" />
            </Link>
          ))}
        </div>

        {/* Recent issues */}
        <div className="veqsio-card">
          <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
            <div><h2 className="text-heading-2 text-[var(--text-primary)]">Recently updated</h2><p className="text-xs text-[var(--text-tertiary)] mt-1">The latest activity across your workspace.</p></div>
            <Link href="/issues" className="text-sm font-medium text-[var(--brand-600)] hover:underline">View all issues</Link>
          </div>

          {recentLoading && (
            <div className="space-y-2">
              <IssueSkeleton />
              <IssueSkeleton />
              <IssueSkeleton />
              <IssueSkeleton />
              <IssueSkeleton />
            </div>
          )}

          {!recentLoading && recentError && (
            <EmptyState
              icon="frown"
              title="Unable to load recent issues"
              description="Check your connection and try again."
              action={
                <button
                  onClick={() => window.location.reload()}
                  className="veqsio-btn-primary"
                >
                  Retry
                </button>
              }
            />
          )}

          {!recentLoading && !recentError && !recentData?.issues?.length && (
            <EmptyState
              icon="inbox"
              title="No recent issues"
              description="Issues will appear here once they are created or updated."
            />
          )}

          {!recentLoading && !recentError && !!recentData?.issues?.length && (
            <div className="space-y-2">
              {recentData.issues.map((issue) => (
                <Link
                  key={issue.id}
                  href={`/issues/${issue.key}`}
                  className="block veqsio-table-row rounded-lg cursor-pointer hover:bg-[var(--surface-1)] transition-colors"
                >
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 min-w-0">
                    <span className="text-caption font-mono text-[var(--text-tertiary)] shrink-0 sm:w-24">
                      {issue.key}
                    </span>
                    <span className="text-body-sm text-[var(--text-primary)] truncate min-w-0 w-full sm:w-auto order-last sm:order-none sm:flex-1">
                      {issue.fields.summary}
                    </span>
                    <span className="ml-auto shrink-0">
                      <StatusBadge status={issue.fields.status?.name || 'Unknown'} />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  )
}
