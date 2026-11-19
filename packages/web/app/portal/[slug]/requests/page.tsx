'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { CheckCircle2, ChevronRight, Plus, Search } from 'lucide-react'
import { PortalHeading, PortalShell, timeAgo } from '@/components/portal-shell'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/skeleton'
import { Avatar } from '@/components/avatar'
import { useMyRequests } from '@/hooks/use-servicedesk'

/** Service level chip: the text always says what it means, the colour only helps. */
const SLA_CHIP: Record<'overdue' | 'paused' | 'on_track' | 'met', { label: string; cls: string }> = {
  overdue: { label: 'Overdue', cls: 'bg-[var(--error-bg,#FEE4E2)] text-[var(--error)]' },
  paused: { label: 'On hold', cls: 'bg-[var(--surface-2)] text-[var(--text-secondary)]' },
  on_track: { label: 'On track', cls: 'bg-[var(--success-bg,#D1FADF)] text-[var(--success,#027A48)]' },
  met: { label: 'Met', cls: 'bg-[var(--success-bg,#D1FADF)] text-[var(--success,#027A48)]' },
}

type Tab = 'open' | 'closed' | 'all'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
]

export default function MyRequestsPage() {
  const { slug } = useParams<{ slug: string }>()
  const { data, isLoading, error } = useMyRequests(slug)
  const [tab, setTab] = useState<Tab>('open')
  const [q, setQ] = useState('')

  const all = data?.values ?? []
  const counts = useMemo(() => ({
    open: all.filter((r) => !r.resolved).length,
    closed: all.filter((r) => r.resolved).length,
    all: all.length,
  }), [all])
  const needle = q.trim().toLowerCase()
  const rows = all
    .filter((r) => (tab === 'all' ? true : tab === 'open' ? !r.resolved : Boolean(r.resolved)))
    .filter((r) => !needle || r.key.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle))
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())

  return (
    <PortalShell slug={slug}>
      <PortalHeading
        title="My requests"
        description="Track everything you have raised and see when we reply."
        action={<Link href={`/portal/${slug}`} className="veqsio-btn-primary min-h-[44px] inline-flex items-center gap-1.5 px-4"><Plus aria-hidden className="w-4 h-4" />Raise a request</Link>}
      />

      <div className="space-y-4">
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div role="tablist" aria-label="Filter requests" className="inline-flex self-start rounded-xl bg-[var(--surface-2)] p-1">
            {TABS.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`min-h-[40px] px-4 rounded-lg text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)] ${
                  tab === t.id ? 'bg-[var(--surface-0)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {t.label}<span className="ml-1.5 text-caption text-[var(--text-tertiary)]">{isLoading ? '' : counts[t.id]}</span>
              </button>
            ))}
          </div>
          <div className="relative sm:w-72">
            <label htmlFor="req-search" className="sr-only">Search my requests</label>
            <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
            <input id="req-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by summary or key" className="veqsio-input w-full min-h-[44px] !pl-9 !pr-3" />
          </div>
        </div>

        {isLoading && (
          <div className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] divide-y divide-[var(--surface-3)]" aria-busy="true" aria-label="Loading requests">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 p-4"><Skeleton className="h-4 w-16" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-6 w-20 rounded-full" /></div>
            ))}
          </div>
        )}
        {error && <p role="alert" className="rounded-lg border border-[var(--error)] px-3 py-2.5 text-body-sm text-[var(--error)]">{error.message}</p>}

        {data && rows.length === 0 && (
          all.length === 0 ? (
            <div className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)]">
              <EmptyState icon="inbox" title="You have not raised any requests yet" description="When you send a request it will show up here, with its status and every reply." action={<Link href={`/portal/${slug}`} className="veqsio-btn-primary min-h-[44px] inline-flex items-center px-5">Raise your first request</Link>} />
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)]">
              <EmptyState
                icon={needle ? 'search' : CheckCircle2}
                title={needle ? 'No matching requests' : tab === 'open' ? 'You are all caught up' : 'Nothing here yet'}
                description={needle ? 'Try a different word or switch to the All tab.' : tab === 'open' ? 'You have no open requests.' : 'No requests in this view.'}
                action={(needle || tab !== 'all') && <button type="button" className="veqsio-btn-secondary min-h-[44px] px-4" onClick={() => { setQ(''); setTab('all') }}>Show all requests</button>}
              />
            </div>
          )
        )}

        {rows.length > 0 && (
          <ul className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] divide-y divide-[var(--surface-3)] overflow-hidden">
            {rows.map((r) => (
              <li key={r.key}>
                <Link href={`/portal/${slug}/requests/${r.key}`} className="group flex items-center gap-3 sm:gap-4 px-4 py-3.5 min-h-[64px] hover:bg-[var(--surface-1)] focus-visible:outline-none focus-visible:bg-[var(--surface-1)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-400)]">
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium text-[var(--text-primary)] truncate">{r.summary}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-[var(--text-tertiary)]">
                      <span className="font-mono">{r.key}</span>
                      {r.requestType && <><span aria-hidden>·</span><span>{r.requestType}</span></>}
                      <span aria-hidden>·</span>
                      <time dateTime={r.created} title={new Date(r.created).toLocaleString()}>Created {timeAgo(r.created)}</time>
                      {r.resolved && <><span aria-hidden>·</span><span>Resolved {timeAgo(r.resolved)}</span></>}
                    </div>
                  </div>
                  {r.sla && <span className={`hidden sm:inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-caption font-medium ${SLA_CHIP[r.sla].cls}`}>{SLA_CHIP[r.sla].label}</span>}
                  {r.assignee && <span className="hidden sm:inline-flex shrink-0" title={`Handled by ${r.assignee}`}><Avatar name={r.assignee} size="sm" /><span className="sr-only">Handled by {r.assignee}</span></span>}
                  <StatusBadge status={r.status} category={r.resolved ? 'done' : undefined} />
                  <ChevronRight aria-hidden className="w-4 h-4 shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PortalShell>
  )
}
