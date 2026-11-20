'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { LineChart } from '@/components/line-chart'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface Summary { responses: number; average: number | null; satisfiedPct: number | null; responseRatePct: number | null }
interface Group extends Summary { key: string | null; name: string }
interface FollowUp { key: string; summary: string; rating: number; comment: string | null; ratedAt: string; customer: string | null; assignee: string | null }
interface Report { days: number; summary: Summary; distribution: Array<{ rating: number; count: number }>; trend: Array<{ week: string; responses: number; average: number | null }>; byAgent: Group[]; byRequestType: Group[]; followUps: FollowUp[] }

const fmt = (n: number | null, digits = 1) => (n === null ? '–' : n.toFixed(digits))
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n)}%`)

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
  return res.json()
}

function GroupTable({ title, rows }: { title: string; rows: Group[] }) {
  const { tr } = useI18n();

  const ms = useMultiSort()
  return (
    <section aria-label={title} className="veqsio-card p-4">
      <h2 className="text-heading-3 mb-2">{title}</h2>
      {rows.length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">{tr('No ratings in this period.')}</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-caption text-[var(--text-tertiary)]"><SortableTh {...ms.th('name')} className="py-1">{tr('Name')}</SortableTh><SortableTh {...ms.th('ratings')}>{tr('Ratings')}</SortableTh><SortableTh {...ms.th('average')}>{tr('Average')}</SortableTh><SortableTh {...ms.th('satisfied')}>{tr('Satisfied')}</SortableTh></tr></thead>
          <tbody>{ms.sort(rows, { name: (g) => g.name, ratings: (g) => g.responses, average: (g) => g.average, satisfied: (g) => g.satisfiedPct }).map((g) => <tr key={g.key ?? 'none'} className="border-t border-[var(--surface-3)]"><td className="py-1.5">{g.name}</td><td>{g.responses}</td><td>{fmt(g.average)}</td><td>{pct(g.satisfiedPct)}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  )
}

export default function CsatReportPage() {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const qc = useQueryClient()
  const [days, setDays] = useState(90)
  const key = ['sd-csat', id, days]
  const report = useQuery({ queryKey: key, queryFn: () => api<Report>(`/rest/servicedeskapi/servicedesk/${id}/csat?days=${days}`) })
  const handled = useMutation({
    mutationFn: (k: string) => api(`/rest/servicedeskapi/servicedesk/${id}/csat/${k}/handled`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sd-csat', id] }); toast(tr('Marked as handled'), 'success') },
    onError: (e) => toast((e as Error).message, 'error'),
  })
  const r = report.data

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Customer satisfaction')}</h1>
          <div className="flex items-center gap-2">
            <label className="text-sm">{tr('Period')} <select className="veqsio-input ml-2 !w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={30}>{tr('Last 30 days')}</option><option value={90}>{tr('Last 90 days')}</option><option value={180}>{tr('Last 180 days')}</option><option value={365}>{tr('Last year')}</option>
              </select>
            </label>
            <Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">{tr('Back to service desk')}</Link>
          </div>
        </div>
        {report.isLoading && <Spinner />}
        {report.error && <p role="alert" className="text-[var(--error)]">{(report.error as Error).message}</p>}
        {r && (
          <>
            <div className="grid gap-4 sm:grid-cols-4">
              {[['Average rating', fmt(r.summary.average, 2)], ['Satisfied (4 or 5)', pct(r.summary.satisfiedPct)], ['Response rate', pct(r.summary.responseRatePct)], ['Ratings', String(r.summary.responses)]].map(([label, value]) => (
                <div key={label} className="veqsio-card p-4"><div className="text-caption text-[var(--text-tertiary)]">{tr(label)}</div><div className="text-display text-[var(--text-primary)]">{value}</div></div>
              ))}
            </div>

            <section aria-label={tr('Trend')} className="veqsio-card p-4">
              <h2 className="text-heading-3 mb-2">{tr('Average rating by week')}</h2>
              <LineChart labels={r.trend.map((w) => w.week.slice(5))} series={[{ name: tr('Average rating'), color: 'var(--brand-500)', values: r.trend.map((w) => w.average) }]} ariaLabel={tr('Average rating per week')} height={220} />
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <GroupTable title={tr('By agent')} rows={r.byAgent} />
              <GroupTable title={tr('By request type')} rows={r.byRequestType} />
            </div>

            <section aria-labelledby="followup-h" className="veqsio-card p-4">
              <h2 id="followup-h" className="text-heading-3 mb-1">{tr('Follow-up queue')}</h2>
              <p className="text-body-sm text-[var(--text-secondary)] mb-3">{tr('Poor ratings (1 or 2) nobody has dealt with yet, oldest first. Reach out to the customer, then mark it handled.')}</p>
              {r.followUps.length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">{tr('Nothing to follow up. 🎉')}</p> : (
                <ul className="divide-y divide-[var(--surface-3)]">
                  {r.followUps.map((f) => (
                    <li key={f.key} className="flex flex-wrap items-start gap-3 py-2">
                      <span className="rounded bg-red-100 px-2 py-0.5 text-sm font-semibold text-red-800" aria-label={`${f.rating} out of 5`}>{f.rating}/5</span>
                      <div className="min-w-0 flex-1">
                        <div><Link className="font-medium text-[var(--brand-600)] hover:underline" href={`/issues/${f.key}`}>{f.key}</Link> {f.summary}</div>
                        <div className="text-body-sm text-[var(--text-secondary)]">{f.customer ?? tr('Customer')}{f.assignee ? ` · handled by ${f.assignee}` : ' · unassigned'} · {new Date(f.ratedAt).toLocaleDateString(getIntlLocale())}</div>
                        {f.comment && <blockquote className="mt-1 border-l-2 border-[var(--surface-4)] pl-2 text-body-sm">{f.comment}</blockquote>}
                      </div>
                      <button type="button" className="veqsio-btn-secondary text-sm" disabled={handled.isPending} onClick={() => handled.mutate(f.key)}>{tr('Mark handled')}<span className="sr-only"> {f.key}</span></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}
