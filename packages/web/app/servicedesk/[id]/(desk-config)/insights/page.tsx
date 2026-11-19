'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'

interface Article { id: number; title: string; published: boolean; views: number; helpful: number; notHelpful: number; helpfulPct: number | null; updatedAt: string }
interface Search { term: string; searches: number; withResults: number }
interface KbReport { days: number; totals: { articles: number; published: number; views: number; neverViewed: number; searches: number }; articles: Article[]; top: Search[]; gaps: Search[] }
interface AutoRow { id: number; name: string; trigger: string; action: string; enabled: boolean; runs: number; failures: number; lastRunAt: string | null; lastFailure: string | null }

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
  return res.json()
}

export default function DeskInsightsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const [days, setDays] = useState(30)
  const base = `/rest/servicedeskapi/servicedesk/${id}`
  const kb = useQuery({ queryKey: ['sd-kb-report', id, days], queryFn: () => api<KbReport>(`${base}/kb-report?days=${days}`) })
  const auto = useQuery({ queryKey: ['sd-auto-report', id, days], queryFn: () => api<{ values: AutoRow[] }>(`${base}/automation-report?days=${days}`) })

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-heading-1 text-[var(--text-primary)]">Knowledge base and automation reports</h1>
          <div className="flex items-center gap-2">
            <label className="text-sm">Period
              <select className="veqsio-input ml-2 !w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
              </select>
            </label>
            <Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">Back to service desk</Link>
          </div>
        </div>

        <section aria-labelledby="kb-h" className="space-y-4">
          <div className="flex items-center justify-between"><h2 id="kb-h" className="text-heading-2">Knowledge base</h2>
            <a className="veqsio-btn-secondary text-sm" href={`${base}/kb-report?format=csv&days=${days}`} download>Export articles (CSV)</a></div>
          {kb.isLoading && <Spinner />}
          {kb.error && <p role="alert" className="text-[var(--error)]">{(kb.error as Error).message}</p>}
          {kb.data && (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                {[['Published articles', `${kb.data.totals.published} of ${kb.data.totals.articles}`], ['Article views', String(kb.data.totals.views)], ['Never viewed', String(kb.data.totals.neverViewed)], [`Searches (${days} days)`, String(kb.data.totals.searches)]].map(([l, v]) => (
                  <div key={l} className="veqsio-card p-4"><div className="text-caption text-[var(--text-tertiary)]">{l}</div><div className="text-display">{v}</div></div>
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="veqsio-card p-4">
                  <h3 className="text-heading-3 mb-1">Searches that found nothing</h3>
                  <p className="text-body-sm text-[var(--text-secondary)] mb-2">Write an article for these: customers looked and left empty-handed.</p>
                  {kb.data.gaps.length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">No gaps in this period.</p> : (
                    <ul className="text-sm divide-y divide-[var(--surface-3)]">{kb.data.gaps.map((g) => <li key={g.term} className="flex justify-between py-1"><span>{g.term}</span><span className="text-[var(--text-tertiary)]">{g.searches}×</span></li>)}</ul>
                  )}
                </div>
                <div className="veqsio-card p-4">
                  <h3 className="text-heading-3 mb-2">Popular searches</h3>
                  {kb.data.top.length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">No searches yet.</p> : (
                    <ul className="text-sm divide-y divide-[var(--surface-3)]">{kb.data.top.map((g) => <li key={g.term} className="flex justify-between py-1"><span>{g.term}</span><span className="text-[var(--text-tertiary)]">{g.searches}× · {g.withResults} with results</span></li>)}</ul>
                  )}
                </div>
              </div>
              <div className="veqsio-card p-4 overflow-x-auto">
                <h3 className="text-heading-3 mb-2">Articles</h3>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-caption text-[var(--text-tertiary)]"><th className="py-1">Article</th><th>Status</th><th>Views</th><th>Helpful</th><th>Not helpful</th><th>Helpful %</th></tr></thead>
                  <tbody>{kb.data.articles.map((a) => (
                    <tr key={a.id} className="border-t border-[var(--surface-3)]"><td className="py-1.5">{a.title}</td><td>{a.published ? 'Published' : 'Draft'}</td><td>{a.views}</td><td>{a.helpful}</td><td>{a.notHelpful}</td><td>{a.helpfulPct === null ? '–' : `${Math.round(a.helpfulPct)}%`}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section aria-labelledby="auto-h" className="veqsio-card p-4 overflow-x-auto">
          <div className="flex items-center justify-between mb-2"><h2 id="auto-h" className="text-heading-2">Automation rule runs</h2>
            <a className="veqsio-btn-secondary text-sm" href={`${base}/automation-report?format=csv&days=${days}`} download>Export (CSV)</a></div>
          {auto.isLoading && <Spinner />}
          {auto.data && (auto.data.values.length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">No rules yet. <Link className="text-[var(--brand-600)] hover:underline" href={`/servicedesk/${id}/automation`}>Create one</Link>.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-caption text-[var(--text-tertiary)]"><th className="py-1">Rule</th><th>Runs</th><th>Failures</th><th>Last run</th><th>Last failure</th></tr></thead>
              <tbody>{auto.data.values.map((r) => (
                <tr key={r.id} className="border-t border-[var(--surface-3)]"><td className="py-1.5">{r.name}{!r.enabled && <span className="ml-2 text-caption text-[var(--text-tertiary)]">(off)</span>}</td><td>{r.runs}</td><td className={r.failures ? 'text-[var(--error)]' : ''}>{r.failures}</td><td>{r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '–'}</td><td className="text-body-sm">{r.lastFailure ?? ''}</td></tr>
              ))}</tbody>
            </table>
          ))}
        </section>
      </div>
    </>
  )
}
