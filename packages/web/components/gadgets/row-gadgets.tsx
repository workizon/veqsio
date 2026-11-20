'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { RichText } from '@/components/rich-text'
import { useGadgetData } from '@/hooks/use-dashboards'
import { EmptyState } from '@/components/empty-state'
import { ChartSkeleton, Kpi } from '@/components/charts/chart-kit'

type Config = Record<string, unknown>

function Failed({ error }: { error: Error }) {
  return <p role="alert" className="p-3 text-body-sm text-[var(--error)]">{error.message}</p>
}

/** Horizontal bars: one row per bucket, the widest = the biggest value. */
function Bars({ buckets, unit }: { buckets: { name: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.value))
  return (
    <ul className="space-y-1.5" role="list">
      {buckets.map((b) => (
        <li key={b.name} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-body-sm">
          <span className="truncate" title={b.name}>{b.name}</span>
          <span className="h-2 rounded-full bg-[var(--surface-2)] overflow-hidden" aria-hidden="true"><span className="block h-full rounded-full bg-[var(--brand-500)]" style={{ width: `${(b.value / max) * 100}%` }} /></span>
          <span className="tabular-nums text-[var(--text-secondary)]">{b.value}{unit ?? ''}</span>
        </li>
      ))}
    </ul>
  )
}

const unitOf = (c: Config) => (c.metric === 'estimate' || c.metric === 'spent' ? ' h' : '')

function Buckets({ type, config }: { type: 'issue-statistics' | 'workload'; config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ buckets: { name: string; value: number }[]; total: number }>(type, config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  if (!q.data?.buckets.length) return <EmptyState icon="inbox" title={tr('No matching issues')} />
  return <Bars buckets={q.data.buckets} unit={unitOf(config)} />
}

function Stat({ config }: { config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ total: number; current?: number; previous?: number; delta?: number; truncated: boolean }>('stat', config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  const d = q.data!
  const days = Number(config.days) || 7
  return (
    <div className="flex flex-col gap-1">
      <Kpi value={String(d.total)} caption={String(config.label || 'matching issues')} />
      {d.delta !== undefined && (
        <p className="text-body-sm text-[var(--text-secondary)]">
          <span className={d.delta > 0 ? 'text-[var(--warning)]' : d.delta < 0 ? 'text-[var(--success)]' : ''}>{d.delta > 0 ? '+' : ''}{d.delta}</span> {tr('created versus the previous')} {days} {tr('days (')}{d.current} {tr('now,')} {d.previous} {tr('before)')} </p>
      )}
    </div>
  )
}

function Table({ config }: { config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ columns: string[]; rows: { name: string; cells: number[]; total: number }[]; totals: number[]; total: number }>('two-dimensional', config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  const d = q.data!
  if (!d.rows.length) return <EmptyState icon="inbox" title={tr('No matching issues')} />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead><tr className="text-left text-[var(--text-secondary)]"><th className="py-1 pr-2 font-medium" /> {d.columns.map((c) => <th key={c} className="py-1 px-2 font-medium text-right">{c}</th>)}<th className="py-1 pl-2 font-medium text-right">{tr('Total')}</th></tr></thead>
        <tbody className="divide-y divide-[var(--surface-3)]">
          {d.rows.map((r) => (
            <tr key={r.name}><th scope="row" className="py-1 pr-2 text-left font-normal">{r.name}</th>{r.cells.map((n, i) => <td key={i} className="py-1 px-2 text-right tabular-nums">{n || <span className="text-[var(--text-tertiary)]">·</span>}</td>)}<td className="py-1 pl-2 text-right tabular-nums font-medium">{r.total}</td></tr>
          ))}
          <tr className="font-medium"><th scope="row" className="py-1 pr-2 text-left">{tr('Total')}</th>{d.totals.map((n, i) => <td key={i} className="py-1 px-2 text-right tabular-nums">{n}</td>)}<td className="py-1 pl-2 text-right tabular-nums">{d.total}</td></tr>
        </tbody>
      </table>
    </div>
  )
}

function Recent({ config }: { config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ issues: { key: string; summary: string; status: string; assignee: string | null }[]; total: number }>('recently-created', config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  if (!q.data?.issues.length) return <EmptyState icon="inbox" title={tr('No matching issues')} />
  return (
    <ul className="divide-y divide-[var(--surface-3)] text-body-sm">
      {q.data.issues.map((i) => (
        <li key={i.key} className="py-1.5 flex gap-2 min-w-0"><Link href={`/issues/${i.key}`} className="font-medium shrink-0 text-[var(--brand-600)] hover:underline">{i.key}</Link><span className="truncate flex-1" title={i.summary}>{i.summary}</span><span className="text-[var(--text-secondary)] shrink-0">{i.status}</span></li>
      ))}
    </ul>
  )
}

/** Calendar heat map: one square per day, weeks as columns (Monday on top), darker = more issues. Counts are also in each square's title. */
function Heatmap({ config }: { config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ field: string; days: { date: string; count: number }[]; max: number; total: number }>('created-heatmap', config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  const d = q.data!
  if (!d.total) return <EmptyState icon="inbox" title={tr('No activity in this period')} />
  const dow = (iso: string) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7 // Monday = 0
  const lead = dow(d.days[0].date)
  const cells: ({ date: string; count: number } | null)[] = [...Array(lead).fill(null), ...d.days]
  const weeks: typeof cells[] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / Math.max(1, d.max)) * 4)))
  const alpha = [0.06, 0.25, 0.45, 0.7, 1]
  return (
    <div>
      <div className="flex gap-[3px] overflow-x-auto pb-1" role="img" aria-label={`${d.total} issues ${d.field} in ${d.days.length} days, busiest day ${d.max}`}>
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {w.map((c, ci) => c
              ? <span key={ci} title={`${c.date}: ${c.count}`} className="block w-3 h-3 rounded-[3px]" style={{ background: 'var(--brand-500)', opacity: alpha[level(c.count)] }} />
              : <span key={ci} className="block w-3 h-3" />)}
          </div>
        ))}
      </div>
      <p className="text-caption text-[var(--text-tertiary)] mt-1">{d.total} issues {d.field} in {d.days.length} {tr('days · busiest day')} {d.max}</p>
    </div>
  )
}

function DueCalendar({ config }: { config: Config }) {
  const { tr } = useI18n();

  const q = useGadgetData<{ days: { date: string; issues: { key: string; summary: string; overdue: boolean; done: boolean }[] }[] }>('due-date-calendar', config)
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <Failed error={q.error as Error} />
  if (!q.data?.days.length) return <EmptyState icon="inbox" title={tr('Nothing due soon')} />
  return (
    <ul className="space-y-2 text-body-sm">
      {q.data.days.map((d) => (
        <li key={d.date}>
          <p className="font-medium text-[var(--text-secondary)]">{new Date(d.date + 'T00:00:00Z').toLocaleDateString(getIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</p>
          <ul>{d.issues.map((i) => (
            <li key={i.key} className="flex gap-2 min-w-0"><Link href={`/issues/${i.key}`} className={`shrink-0 hover:underline ${i.done ? 'line-through text-[var(--text-tertiary)]' : ''}`}>{i.key}</Link><span className="truncate">{i.summary}</span>{i.overdue && <span className="text-[var(--error)] shrink-0">overdue</span>}</li>
          ))}</ul>
        </li>
      ))}
    </ul>
  )
}

export function RowGadget({ type, config }: { type: string; config: Config }) {
  const { tr } = useI18n();

  switch (type) {
    case 'issue-statistics': return <Buckets type="issue-statistics" config={config} />
    case 'workload': return <Buckets type="workload" config={config} />
    case 'stat': return <Stat config={config} />
    case 'two-dimensional': return <Table config={config} />
    case 'recently-created': return <Recent config={config} />
    case 'created-heatmap': return <Heatmap config={config} />
    case 'due-date-calendar': return <DueCalendar config={config} />
    case 'notes': return String(config.text ?? '')
      ? <RichText value={String(config.text)} format="markdown" className="text-body-sm break-words" />
      : <p className="text-body-sm text-[var(--text-tertiary)]">{tr('Empty note. Edit the gadget to add text.')}</p>
    default: return null
  }
}
