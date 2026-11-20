'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useDefaultDashboard } from '@/hooks/use-dashboards'
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDot, FolderKanban, Inbox, KanbanSquare, ListTodo, Plus, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'
import { Avatar } from '@/components/avatar'
import { useMyself } from '@/hooks/use-issues'
import { useUIStore } from '@/components/ui-store'

interface SearchIssue {
  id: string
  key: string
  fields: {
    summary: string
    status?: { name: string; category?: string }
    priority?: { name: string } | null
    issuetype?: { name: string }
    assignee?: { displayName: string } | null
    updated: string
  }
}
interface SearchResponse { total: number; issues: SearchIssue[] }
interface ProjectSummary { id: number; key: string; name: string }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

const search = (jql: string, max: number) =>
  `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,priority,issuetype,assignee,updated`

function useCount(jql: string) {
  return useQuery({ queryKey: ['home-count', jql], queryFn: () => fetchJson<SearchResponse>(search(jql, 0)) })
}
function useIssueList(key: string, jql: string, max: number) {
  return useQuery({ queryKey: ['home-list', key], queryFn: () => fetchJson<SearchResponse>(search(jql, max)) })
}

const OPEN = 'status not in (Done, Closed, Resolved)'

function greeting(now = new Date()): string {
  const h = now.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function StatTile({ label, value, loading, icon: Icon, tone, href }: {
  label: string; value: number | undefined; loading: boolean; icon: LucideIcon; tone: string; href: string
}) {
  return (
    <Link
      href={href}
      className="group veqsio-card !p-4 flex items-center gap-3 hover:border-[var(--surface-4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)]"
    >
      <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}>
        <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] text-[var(--text-secondary)]">{label}</span>
        {loading ? (
          <span className="block h-7 w-10 mt-0.5 rounded bg-[var(--surface-2)] animate-pulse" />
        ) : (
          <span className="block text-[22px] leading-7 font-semibold tracking-tight tabular-nums text-[var(--text-primary)]">{value ?? 0}</span>
        )}
      </span>
      <ArrowRight className="w-4 h-4 ml-auto text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
    </Link>
  )
}

function IssueLine({ issue, showAssignee }: { issue: SearchIssue; showAssignee?: boolean }) {
  const { tr } = useI18n();

  return (
    <Link
      href={`/issues/${issue.key}`}
      className="flex items-center gap-3 px-4 py-2 min-h-[40px] border-b border-[var(--surface-3)] last:border-b-0 hover:bg-[var(--surface-1)] transition-colors focus-visible:outline-none focus-visible:bg-[var(--surface-2)]"
    >
      <IssueTypeGlyph name={issue.fields.issuetype?.name} />
      <span className="w-[72px] shrink-0 text-[12px] font-medium tabular-nums text-[var(--text-secondary)]">{issue.key}</span>
      <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{issue.fields.summary}</span>
      {issue.fields.priority && <span className="hidden md:inline-flex"><PriorityBadge priority={issue.fields.priority.name} iconOnly /></span>}
      <span className="hidden sm:inline-flex"><StatusBadge status={issue.fields.status?.name || 'Unknown'} category={issue.fields.status?.category as never} /></span>
      {showAssignee && (issue.fields.assignee
        ? <Avatar name={issue.fields.assignee.displayName} size="sm" />
        : <span className="w-5 h-5 rounded-full border border-dashed border-[var(--surface-4)]" title={tr('Unassigned')} />)}
      <span className="hidden lg:block w-14 text-right text-[12px] text-[var(--text-tertiary)] tabular-nums">{timeAgo(issue.fields.updated)}</span>
    </Link>
  )
}

function ListCard({ title, action, loading, error, issues, empty, showAssignee }: {
  title: string; action?: { href: string; label: string }; loading: boolean; error: Error | null
  issues: SearchIssue[] | undefined; empty: { title: string; hint: string }; showAssignee?: boolean
}) {
  const { tr } = useI18n();

  return (
    <section className="veqsio-card !p-0 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--surface-3)]">
        <h2 className="text-heading-3 text-[var(--text-primary)]">{title}</h2>
        {action && <Link href={action.href} className="text-[12px] font-medium text-[var(--brand-600)] hover:underline">{tr(action.label)}</Link>}
      </header>
      {loading && Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--surface-3)] last:border-b-0 animate-pulse">
          <span className="w-4 h-4 rounded bg-[var(--surface-2)]" /><span className="h-3 w-14 rounded bg-[var(--surface-2)]" />
          <span className="h-3 flex-1 max-w-[320px] rounded bg-[var(--surface-2)]" /><span className="h-4 w-16 rounded-full bg-[var(--surface-2)] ml-auto" />
        </div>
      ))}
      {!loading && error && <p role="alert" className="px-4 py-6 text-[13px] text-[var(--error)]">{tr('Could not load this list:')} {error.message}</p>}
      {!loading && !error && !issues?.length && (
        <div className="px-4 py-8 text-center">
          <Inbox className="w-6 h-6 mx-auto text-[var(--text-tertiary)]" aria-hidden="true" />
          <p className="mt-2 text-[13px] font-medium text-[var(--text-primary)]">{tr(empty.title)}</p>
          <p className="text-[12px] text-[var(--text-tertiary)]">{tr(empty.hint)}</p>
        </div>
      )}
      {!loading && !error && issues?.map((i) => <IssueLine key={i.id} issue={i} showAssignee={showAssignee} />)}
    </section>
  )
}

export default function YourWorkPage() {
  const { tr } = useI18n();

  // A default dashboard (chosen on the dashboards page) opens instead of Home; Home itself stays at /dashboard?home=1.
  const router = useRouter()
  const wantsHome = useSearchParams()?.get('home') === '1'
  const defaultDashboard = useDefaultDashboard()
  useEffect(() => {
    if (!wantsHome && defaultDashboard.data?.id) router.replace(`/dashboards/${defaultDashboard.data.id}`)
  }, [wantsHome, defaultDashboard.data?.id, router])
  const { data: me } = useMyself()
  const { setCreateOpen } = useUIStore()
  const open = useCount(OPEN)
  const inProgress = useCount('status = "In Progress"')
  const done = useCount('status in (Done, Closed, Resolved) AND updated >= -7d')
  const overdue = useCount(`duedate < now() AND ${OPEN}`)
  const mine = useIssueList('mine', `assignee = currentUser() AND ${OPEN} ORDER BY priority DESC, updated DESC`, 8)
  const recent = useIssueList('recent', 'ORDER BY updated DESC', 8)
  const projects = useQuery({
    queryKey: ['home-projects'],
    queryFn: () => fetchJson<ProjectSummary[] | { values?: ProjectSummary[] }>('/rest/api/2/project').then((d) => (Array.isArray(d) ? d : d.values ?? [])),
  })

  const profile = me as { displayName?: string; name?: string } | undefined
  const name = (profile?.displayName || profile?.name)?.split(' ')[0]
  const q = (jql: string) => `/issues?jql=${encodeURIComponent(jql)}`

  return (
    <AppLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-heading-1 text-[var(--text-primary)]">
              {tr(greeting())}{name ? `, ${name}` : ''}
            </h1>
            <p className="text-body text-[var(--text-secondary)] mt-0.5">
              {new Date().toLocaleDateString(getIntlLocale(), { weekday: 'long', month: 'long', day: 'numeric' })}
              {mine.data ? ` · ${tr(mine.data.total === 1 ? '{n} open issue assigned to you' : '{n} open issues assigned to you', { n: mine.data.total })}` : ''}
            </p>
          </div>
          <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary"><Plus className="w-4 h-4" />{tr('Create issue')}</button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label={tr('Open issues')} value={open.data?.total} loading={open.isLoading} icon={CircleDot} tone="var(--text-secondary)" href={q(OPEN)} />
          <StatTile label={tr('In progress')} value={inProgress.data?.total} loading={inProgress.isLoading} icon={Timer} tone="var(--brand-500)" href={q('status = "In Progress"')} />
          <StatTile label={tr('Done this week')} value={done.data?.total} loading={done.isLoading} icon={CheckCircle2} tone="var(--success)" href={q('status in (Done, Closed, Resolved) AND updated >= -7d')} />
          <StatTile label={tr('Overdue')} value={overdue.data?.total} loading={overdue.isLoading} icon={AlertTriangle} tone="var(--error)" href={q(`duedate < now() AND ${OPEN}`)} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-4 min-w-0">
            <ListCard
              title={tr('Assigned to me')} action={{ href: q(`assignee = currentUser() AND ${OPEN}`), label: tr('View all') }}
              loading={mine.isLoading} error={mine.error} issues={mine.data?.issues}
              empty={{ title: tr('Nothing assigned to you'), hint: tr('Issues assigned to you will show up here.') }}
            />
            <ListCard
              title={tr('Recently updated')} action={{ href: '/issues', label: tr('All issues') }}
              loading={recent.isLoading} error={recent.error} issues={recent.data?.issues} showAssignee
              empty={{ title: tr('No issues yet'), hint: tr('Create the first issue to get started.') }}
            />
          </div>

          <div className="space-y-4 min-w-0">
            <section className="veqsio-card !p-0 overflow-hidden">
              <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--surface-3)]">
                <h2 className="text-heading-3 text-[var(--text-primary)]">{tr('Projects')}</h2>
                <Link href="/projects" className="text-[12px] font-medium text-[var(--brand-600)] hover:underline">{tr('View all')}</Link>
              </header>
              {projects.isLoading && <div className="px-4 py-3"><span className="block h-4 w-40 rounded bg-[var(--surface-2)] animate-pulse" /></div>}
              {!projects.isLoading && !projects.data?.length && <p className="px-4 py-6 text-[13px] text-[var(--text-tertiary)]">{tr('No projects yet.')}</p>}
              {projects.data?.slice(0, 6).map((p) => (
                <Link key={p.id} href={`/projects/${p.key}`} className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--surface-3)] last:border-b-0 hover:bg-[var(--surface-1)] transition-colors">
                  <span className="w-7 h-7 rounded-md bg-[var(--brand-50)] text-[var(--brand-700)] text-[11px] font-bold flex items-center justify-center shrink-0">{p.key.slice(0, 2)}</span>
                  <span className="min-w-0"><span className="block text-[13px] font-medium text-[var(--text-primary)] truncate">{p.name}</span><span className="block text-[11px] text-[var(--text-tertiary)]">{p.key}</span></span>
                </Link>
              ))}
            </section>

            <section className="veqsio-card !p-0 overflow-hidden">
              <header className="px-4 py-3 border-b border-[var(--surface-3)]"><h2 className="text-heading-3 text-[var(--text-primary)]">{tr('Jump to')}</h2></header>
              {([
                { href: '/boards', label: tr('Board'), hint: tr('Active sprint'), Icon: KanbanSquare },
                { href: '/backlog', label: tr('Backlog'), hint: tr('Plan sprints'), Icon: ListTodo },
                { href: '/dashboards', label: tr('Dashboards'), hint: tr('Charts and gadgets'), Icon: FolderKanban },
              ] as const).map(({ href, label, hint, Icon }) => (
                <Link key={href} href={href} className="group flex items-center gap-3 px-4 py-2.5 border-b border-[var(--surface-3)] last:border-b-0 hover:bg-[var(--surface-1)] transition-colors">
                  <Icon className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">{tr(label)}</span>
                  <span className="text-[12px] text-[var(--text-tertiary)]">{tr(hint)}</span>
                  <ArrowRight className="w-3.5 h-3.5 ml-auto text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
                </Link>
              ))}
            </section>
          </div>
        </div>
      </div>
    </AppLayout>
  )
}
