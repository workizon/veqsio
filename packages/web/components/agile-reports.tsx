'use client'

import Link from 'next/link'
import { Flag } from 'lucide-react'
import { AreaTrend, type ChartMarker } from '@/components/charts/area-trend'
import { Kpi, LegendPills, SERIES } from '@/components/charts/chart-kit'
import {
  burnupRows, formatQty, formatVelocity, percentDone, projectionSummary, releaseRows, scopeChangeSummary, unitNoun,
  type ReportUnit,
} from '@/lib/agile-series'

const today = () => new Date().toISOString().slice(0, 10)
const TONE = { good: 'var(--success)', bad: 'var(--error)', neutral: 'var(--text-primary)' } as const

/** Scope line (steps when work is added or removed) against the completed line, plus the list of scope changes. */
export function BurnupView({ data, unit }: { data: any; unit: ReportUnit }) {
  const rows = burnupRows(data.points)
  const markers: ChartMarker[] = [{ x: today(), label: 'Today' }]
  const changes: Array<{ at: string; key: string; kind: 'added' | 'removed'; size: number }> = data.scopeChanges ?? []
  return (
    <div className="space-y-4" data-testid="burnup">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Kpi value={formatQty(data.scope, unit)} caption="Scope now" />
        <Kpi value={formatQty(data.completed, unit)} caption={`Completed (${percentDone(data.completed, data.scope)}%)`} tone="var(--success)" />
        <Kpi value={formatQty(data.initialScope, unit)} caption="Committed at the start" />
        <Kpi value={scopeChangeSummary(changes, unit)} caption="Scope changes" />
      </div>
      <figure role="img" aria-label="Burnup chart: scope and completed work per day" className="space-y-2">
        <LegendPills items={[{ name: 'Scope', color: SERIES.amber }, { name: 'Completed', color: SERIES.green }]} />
        <AreaTrend
          data={rows} xKey="date" height={280} markers={markers} formatValue={(v) => formatQty(Number(v), unit)}
          series={[
            { key: 'completed', name: 'Completed', color: SERIES.green },
            { key: 'scope', name: 'Scope', color: SERIES.amber, line: true, stepped: true },
          ]}
        />
      </figure>
      {changes.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-1">Scope changes</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[var(--text-secondary)]"><th className="py-1">When</th><th>Issue</th><th>Change</th><th className="text-right">Size</th></tr></thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i} className="border-t border-[var(--surface-3)]">
                  <td className="py-1.5">{new Date(c.at).toLocaleString()}</td>
                  <td><Link href={`/issues/${c.key}`} className="text-[var(--brand-600)] hover:underline">{c.key}</Link></td>
                  <td>{c.kind === 'added' ? 'Added to scope' : 'Removed from scope'}</td>
                  <td className="text-right tabular-nums">{c.kind === 'added' ? '+' : '-'}{c.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Remaining work with the ideal line to the release date and the projection from recent velocity. */
export function ReleaseBurndownView({ data, unit, title }: { data: any; unit: ReportUnit; title: string }) {
  const rows = releaseRows(data.points)
  const markers: ChartMarker[] = [{ x: today(), label: 'Today' }]
  if (data.releaseDate) markers.push({ x: data.releaseDate, label: 'Release', color: 'var(--brand-500)' })
  const proj = projectionSummary({ projectedDate: data.projectedDate, releaseDate: data.releaseDate, onTrack: data.onTrack, daysLate: data.daysLate })
  return (
    <div className="space-y-4" data-testid="release-burndown">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Kpi value={formatQty(data.remaining, unit)} caption="Remaining" />
        <Kpi value={formatQty(data.completed, unit)} caption={`Completed of ${formatQty(data.scope, unit)}`} tone="var(--success)" />
        <Kpi value={data.projectedDate ?? 'n/a'} caption="Projected finish" tone={TONE[proj.tone]} />
        <Kpi value={data.releaseDate ?? 'not set'} caption="Release date" />
      </div>
      <p className="text-sm" style={{ color: TONE[proj.tone] }} data-testid="projection">{proj.text}</p>
      <p className="text-caption text-[var(--text-tertiary)]">Pace: {formatVelocity(data.velocityPerDay, unit, data.lookbackDays)}.</p>
      <figure role="img" aria-label={`${title}: remaining work, ideal line and projection`} className="space-y-2">
        <LegendPills items={[
          { name: 'Remaining', color: SERIES.brand },
          ...(data.releaseDate ? [{ name: 'Ideal', color: SERIES.slate }] : []),
          { name: 'Projection', color: SERIES.amber },
        ]} />
        <AreaTrend
          data={rows} xKey="date" height={300} markers={markers} formatValue={(v) => formatQty(Number(v), unit)}
          series={[
            { key: 'remaining', name: 'Remaining', color: SERIES.brand, stepped: true },
            { key: 'ideal', name: 'Ideal', color: SERIES.slate, dashed: true },
            { key: 'projected', name: 'Projection', color: SERIES.amber, dashed: true },
          ]}
        />
      </figure>
    </div>
  )
}

const CATEGORY_TONE: Record<string, string> = { todo: 'var(--text-tertiary)', in_progress: 'var(--brand-500)', done: 'var(--success)' }

/** Jira's version report: counts, completed vs remaining, projected release date and the issues grouped by status. */
export function VersionReportView({ data, unit }: { data: any; unit: ReportUnit }) {
  const v = data.version
  const proj = projectionSummary(data.projection)
  const c = data.issues
  const pct = percentDone(data.completed, data.total)
  return (
    <div className="space-y-5" data-testid="version-report">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-heading-3">{v.name}</h2>
        <span className={`text-caption px-2 py-0.5 rounded-full ${v.released ? 'bg-[var(--surface-2)] text-[var(--text-secondary)]' : 'bg-[var(--brand-50)] text-[var(--brand-700)]'}`}>
          {v.released ? 'Released' : 'Unreleased'}
        </span>
        {v.releaseDate && <span className="text-caption text-[var(--text-tertiary)]">Release date {v.releaseDate}</span>}
      </div>
      {v.description && <p className="text-sm text-[var(--text-secondary)]">{v.description}</p>}

      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Kpi value={c.done} caption="Issues done" tone="var(--success)" />
        <Kpi value={c.inProgress} caption="In progress" tone="var(--brand-500)" />
        <Kpi value={c.todo} caption="To do" />
        <Kpi value={formatQty(data.completed, unit)} caption="Completed" tone="var(--success)" />
        <Kpi value={formatQty(data.remaining, unit)} caption="Remaining" />
        <Kpi value={data.unestimated} caption={`Without ${unitNoun(unit)} estimate`} />
        {data.flagged > 0 && <Kpi value={data.flagged} caption="Flagged" tone="var(--error)" />}
      </div>

      <div>
        <div className="h-2.5 bg-[var(--surface-3)] rounded overflow-hidden flex" role="img" aria-label={`${pct}% of the work is done`}>
          <div style={{ width: `${pct}%`, background: 'var(--success)' }} />
        </div>
        <div className="mt-1 text-caption text-[var(--text-tertiary)]">{pct}% complete</div>
      </div>

      <p className="text-sm" style={{ color: TONE[proj.tone] }} data-testid="projection">
        {data.projection ? `Projected release: ${proj.text}.` : 'This version has been released.'}
        {data.projection && <span className="text-[var(--text-tertiary)]"> {formatVelocity(data.projection.velocityPerDay, unit, data.projection.lookbackDays)}.</span>}
      </p>

      {data.groups.length === 0 ? (
        <p className="text-[var(--text-tertiary)]">No issues have this fix version yet. Set Fix versions on an issue to see it here.</p>
      ) : (
        <div className="space-y-4">
          {data.groups.map((g: any) => (
            <section key={g.status}>
              <h3 className="text-sm font-medium flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: CATEGORY_TONE[g.category] }} aria-hidden="true" />
                {g.status} <span className="text-[var(--text-tertiary)] font-normal">({g.issues.length})</span>
              </h3>
              <table className="w-full text-sm mt-1">
                <tbody>
                  {g.issues.map((i: any) => (
                    <tr key={i.key} className="border-t border-[var(--surface-3)] min-h-[44px]">
                      <td className="py-2 w-28 whitespace-nowrap">
                        <Link href={`/issues/${i.key}`} className="text-[var(--brand-600)] hover:underline">{i.key}</Link>
                      </td>
                      <td className="min-w-0">
                        {i.flagged && <Flag className="inline w-3.5 h-3.5 mr-1 text-[var(--error)]" aria-label="Flagged" />}
                        {i.summary}
                      </td>
                      <td className="hidden sm:table-cell text-[var(--text-secondary)] w-36 truncate">{i.assignee ?? 'Unassigned'}</td>
                      <td className="text-right tabular-nums w-20">{i.estimated ? i.size : <span title="No estimate" className="text-[var(--text-tertiary)]">-</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
