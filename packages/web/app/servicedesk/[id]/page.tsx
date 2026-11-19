'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import { SlaBadge } from '@/components/sla-badge'
import { BarTrend } from '@/components/charts/bar-trend'
import { LegendPills, SERIES } from '@/components/charts/chart-kit'
import { useDeskQueues, useDeskReport, useDeskRequests } from '@/hooks/use-servicedesk'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

type Tab = 'queues' | 'report'

export default function ServiceDeskPage() {
  const ms = useMultiSort()
  const id = Number(useParams<{ id: string }>().id)
  const [tab, setTab] = useState<Tab>('queues')
  const [queue, setQueue] = useState<string>('')
  const [openOnly, setOpenOnly] = useState(true)
  const [q, setQ] = useState('')
  const [start, setStart] = useState(0)
  const PAGE = 50

  const queues = useDeskQueues(id)
  const params: Record<string, string> = {}
  if (queue) params.queue = queue
  if (openOnly) params.open = 'true'
  if (q) params.q = q
  params.limit = String(PAGE)
  params.start = String(start)
  const requests = useDeskRequests(id, params)
  const [days, setDays] = useState(30)
  const report = useDeskReport(id, days)

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-heading-1 text-[var(--text-primary)]">Service desk</h1>
          <Link href={`/servicedesk/${id}/new-request`} className="veqsio-btn-primary ml-auto mr-2">Create request</Link>
          <Link href={`/servicedesk/${id}/settings`} className="veqsio-btn-secondary mr-2">Settings</Link>
          <Link href={`/servicedesk/${id}/sla`} className="veqsio-btn-secondary mr-2">SLAs</Link>
          <Link href={`/servicedesk/${id}/calendars`} className="veqsio-btn-secondary mr-2">Calendars</Link>
          <Link href={`/servicedesk/${id}/canned`} className="veqsio-btn-secondary mr-2">Canned responses</Link>
          <Link href={`/servicedesk/${id}/csat`} className="veqsio-btn-secondary mr-2">Satisfaction</Link>
          <div role="tablist" className="flex gap-1">
            {(['queues', 'report'] as Tab[]).map((t) => (
              <button
                key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={tab === t ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'}
              >
                {t === 'queues' ? 'Queues' : 'Reports'}
              </button>
            ))}
          </div>
        </div>

        {tab === 'queues' && (
          <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
            <nav aria-label="Queues" className="veqsio-card p-2 space-y-1 h-fit">
              <button onClick={() => { setQueue(''); setStart(0) }} className={`w-full text-left px-3 py-2 rounded ${queue === '' ? 'bg-[var(--surface-2)] font-medium' : ''}`}>
                All requests
              </button>
              {queues.data?.values.map((x) => (
                <button key={x.id} onClick={() => { setQueue(String(x.id)); setStart(0) }} className={`w-full text-left px-3 py-2 rounded ${queue === String(x.id) ? 'bg-[var(--surface-2)] font-medium' : ''}`}>
                  <span className="flex items-center justify-between gap-2"><span>{x.name}</span>
                    {typeof x.count === 'number' && <span className="text-xs text-[var(--text-tertiary)] tabular-nums" aria-label={`${x.count} requests`}>{x.count}</span>}</span>
                </button>
              ))}
            </nav>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <input className="veqsio-input max-w-xs" placeholder="Search requests" aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only
                </label>
              </div>
              {requests.isLoading && <Spinner />}
              {requests.error && <div className="text-[var(--error)]">{requests.error.message}</div>}
              {requests.data && (
                <div className="veqsio-card p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="veqsio-table-header text-left">
                        <SortableTh {...ms.th('key')} className="px-3 py-2">Key</SortableTh><SortableTh {...ms.th('name')} className="px-3 py-2">Summary</SortableTh>
                        <th className="px-3 py-2">SLA</th><SortableTh {...ms.th('created')} className="px-3 py-2">Created</SortableTh>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.data.values.length === 0 && (
                        <tr><td colSpan={4} className="px-3 py-8 text-center text-[var(--text-tertiary)]">No requests in this queue</td></tr>
                      )}
                      {ms.sort(requests.data.values, { key: (r) => r.key, name: (r) => r.summary, created: (r) => new Date(r.created) }).map((r) => (
                        <tr key={r.key} className="veqsio-table-row">
                          <td className="px-3 py-2"><Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${r.key}`}>{r.key}</Link></td>
                          <td className="px-3 py-2">{r.summary}</td>
                          <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{r.sla.map((s) => <SlaBadge key={s.slaId} sla={s} />)}</div></td>
                          <td className="px-3 py-2 whitespace-nowrap">{new Date(r.created).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(requests.data.total ?? 0) > PAGE && (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[var(--border)] text-sm">
                      <span aria-live="polite">{start + 1}-{Math.min(start + PAGE, requests.data.total!)} of {requests.data.total}</span>
                      <span className="flex gap-2">
                        <button className="veqsio-btn-secondary" disabled={start === 0} onClick={() => setStart(Math.max(0, start - PAGE))}>Previous</button>
                        <button className="veqsio-btn-secondary" disabled={start + PAGE >= requests.data.total!} onClick={() => setStart(start + PAGE)}>Next</button>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'report' && (
          <div className="space-y-4">
            {report.isLoading && <Spinner />}
            {report.data && (
              <>
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                  <Stat label="Total requests" value={report.data.total} />
                  <Stat label="Open" value={report.data.open} />
                  <Stat label="Resolved" value={report.data.resolved} />
                  <Stat label="CSAT" value={report.data.csat.average === null ? '—' : `${report.data.csat.average.toFixed(1)} / 5`} hint={`${report.data.csat.responses} responses`} />
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-[var(--text-secondary)]">Period:</span>
                  {[7, 30, 90].map((d) => (
                    <button key={d} onClick={() => setDays(d)}
                      className={`px-2 py-1 rounded ${days === d ? 'bg-[var(--surface-3)] font-semibold' : 'text-[var(--text-secondary)]'}`}>
                      {d} days
                    </button>
                  ))}
                </div>
                <div className="veqsio-card p-4">
                  <h2 className="text-heading-3 mb-3">Created vs resolved</h2>
                  <CreatedResolvedChart data={report.data.daily} />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="veqsio-card p-4">
                    <h2 className="text-heading-3 mb-3">Workload per agent</h2>
                    {report.data.workload.length === 0 && <p className="text-[var(--text-tertiary)]">No assigned requests.</p>}
                    <table className="w-full text-sm">
                      <tbody>
                        {report.data.workload.map((w) => (
                          <tr key={w.userId ?? 'none'} className="border-t border-[var(--surface-3)] first:border-t-0">
                            <td className="py-2">{w.name}</td>
                            <td className="py-2 text-right text-[var(--text-secondary)]">{w.open} open · {w.resolved} resolved</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="veqsio-card p-4">
                    <h2 className="text-heading-3 mb-3">CSAT distribution</h2>
                    {report.data.csatDistribution.map((d) => {
                      const max = Math.max(1, ...report.data!.csatDistribution.map((x) => x.count))
                      return (
                        <div key={d.rating} className="flex items-center gap-2 py-1 text-sm">
                          <span className="w-8">{d.rating} ★</span>
                          <div className="flex-1 h-3 rounded bg-[var(--surface-3)]">
                            <div className="h-3 rounded bg-[#2563eb]" style={{ width: `${(d.count / max) * 100}%` }} />
                          </div>
                          <span className="w-8 text-right text-[var(--text-secondary)]">{d.count}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="veqsio-card p-4">
                  <h2 className="text-heading-3 mb-3">SLA compliance</h2>
                  {report.data.sla.length === 0 && <p className="text-[var(--text-tertiary)]">No SLAs configured.</p>}
                  {report.data.sla.map((s) => (
                    <div key={s.slaId} className="flex items-center justify-between py-2 border-t border-[var(--surface-3)] first:border-t-0">
                      <span>{s.name}</span>
                      <span className="text-sm text-[var(--text-secondary)]">
                        {s.met} met · {s.breached} breached · {s.running} running ·{' '}
                        <strong>{s.compliance === null ? '—' : `${Math.round(s.compliance * 100)}%`}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="veqsio-card p-4">
      <div className="text-sm text-[var(--text-secondary)]">{label}</div>
      <div className="text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
      {hint && <div className="text-xs text-[var(--text-tertiary)]">{hint}</div>}
    </div>
  )
}

function CreatedResolvedChart({ data }: { data: Array<{ date: string; created: number; resolved: number }> }) {
  return (
    <div className="space-y-2">
      <LegendPills items={[{ name: 'Created', color: SERIES.brand }, { name: 'Resolved', color: SERIES.green }]} />
      <BarTrend
        data={data} xKey="date" height={200}
        series={[{ key: 'created', name: 'Created', color: SERIES.brand }, { key: 'resolved', name: 'Resolved', color: SERIES.green }]}
        formatValue={(v) => `${v}`}
      />
    </div>
  )
}
