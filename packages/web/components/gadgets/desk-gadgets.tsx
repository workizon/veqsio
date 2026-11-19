'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useDeskQueues, useDeskReport } from '@/hooks/use-servicedesk'
import { EmptyState } from '@/components/empty-state'
import { ChartSkeleton, Kpi } from '@/components/charts/chart-kit'
import { useGadgetData } from '@/hooks/use-dashboards'

type Config = Record<string, unknown>
const deskOf = (c: Config) => Number(c.deskId) || 0

function NoDesk() { return <EmptyState icon="inbox" title="Choose a service desk" description="This gadget needs a deskId in its configuration." /> }

function QueueCounts({ id }: { id: number }) {
  const q = useDeskQueues(id)
  if (q.isLoading) return <ChartSkeleton />
  const rows = q.data?.values ?? []
  if (!rows.length) return <EmptyState icon="inbox" title="No queues" />
  return (
    <ul className="divide-y divide-[var(--surface-3)]">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between py-2 text-body-sm">
          <Link href={`/servicedesk/${id}?queue=${r.id}`} className="hover:underline">{r.name}</Link>
          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs tabular-nums">{r.count ?? '–'}</span>
        </li>
      ))}
    </ul>
  )
}

function SlaRows({ id, days, mode }: { id: number; days: number; mode: 'compliance' | 'breaches' }) {
  const q = useDeskReport(id, days)
  if (q.isLoading) return <ChartSkeleton />
  const sla = q.data?.sla ?? []
  if (!sla.length) return <EmptyState icon="inbox" title="No SLAs configured" />
  const rows = mode === 'breaches' ? [...sla].sort((a, b) => b.breached - a.breached) : sla
  return (
    <ul className="space-y-3">
      {rows.map((s) => {
        const pct = s.compliance === null ? null : Math.round(s.compliance * 100)
        return (
          <li key={s.slaId} className="text-body-sm">
            <div className="flex items-baseline justify-between"><span className="font-medium">{s.name}</span><span className="tabular-nums">{mode === 'breaches' ? `${s.breached} breached` : pct === null ? '–' : `${pct}%`}</span></div>
            <div className="mt-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden" aria-hidden="true"><div className={`h-full rounded-full ${mode === 'breaches' && s.breached > 0 ? 'bg-[var(--error)]' : 'bg-[var(--success)]'}`} style={{ width: `${mode === 'breaches' ? Math.min(100, s.breached * 20) : pct ?? 0}%` }} /></div>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{s.met} met · {s.breached} breached · {s.running} running</p>
          </li>
        )
      })}
    </ul>
  )
}

function Csat({ id, days }: { id: number; days: number }) {
  const q = useDeskReport(id, days)
  if (q.isLoading) return <ChartSkeleton />
  const d = q.data
  if (!d || d.csat.responses === 0) return <EmptyState icon="inbox" title="No ratings yet" />
  const max = Math.max(1, ...d.csatDistribution.map((x) => x.count))
  return (
    <div className="space-y-3">
      <Kpi value={d.csat.average === null ? '–' : d.csat.average.toFixed(1)} caption={`average of ${d.csat.responses} rating${d.csat.responses === 1 ? '' : 's'}`} />
      {d.csatDistribution.map((x) => (
        <div key={x.rating} className="flex items-center gap-2 text-body-sm"><span className="w-8">{x.rating} ★</span><div className="flex-1 h-2 rounded bg-[var(--surface-2)]"><div className="h-2 rounded bg-[var(--brand-500)]" style={{ width: `${(x.count / max) * 100}%` }} /></div><span className="w-6 text-right tabular-nums text-[var(--text-secondary)]">{x.count}</span></div>
      ))}
    </div>
  )
}

/** Service desk gadgets: queue counts, SLA compliance, SLA breaches and customer satisfaction of one desk. */
export function DeskGadget({ type, config }: { type: string; config: Config }) {
  const id = deskOf(config)
  const days = Number(config.days) || 30
  if (!id) return <NoDesk />
  if (type === 'queue-counts') return <QueueCounts id={id} />
  if (type === 'csat') return <Csat id={id} days={days} />
  return <SlaRows id={id} days={days} mode={type === 'sla-breaches' ? 'breaches' : 'compliance'} />
}

/** Progress of one version: its issues by status category, as a bar. */
export function VersionProgressGadget({ config }: { config: Config }) {
  const projectId = Number(config.projectId) || 0
  const versionId = Number(config.versionId) || 0
  const meta = useQuery({
    queryKey: ['version-gadget-meta', projectId, versionId], enabled: !!projectId && !!versionId, staleTime: 60_000,
    queryFn: async () => {
      const projects = (await (await fetch('/rest/api/2/project', { credentials: 'include' })).json()) as Array<{ id: number; key: string }>
      const key = projects.find((p) => p.id === projectId)?.key
      if (!key) return null
      const versions = (await (await fetch(`/rest/api/2/project/${key}/versions`, { credentials: 'include' })).json()) as Array<{ id: number; name: string }>
      const name = versions.find((v) => v.id === versionId)?.name
      return name ? { key, name } : null
    },
  })
  const jql = meta.data ? `project = ${meta.data.key} AND fixVersion = "${meta.data.name}"` : ''
  const buckets = useGadgetData<{ buckets: { name: string; value: number }[]; total: number }>('issue-statistics', { jql, field: 'statusCategory' })
  if (!projectId || !versionId) return <EmptyState icon="inbox" title="Choose a version" />
  if (meta.isLoading || buckets.isLoading) return <ChartSkeleton />
  const total = buckets.data?.total ?? 0
  if (!total) return <EmptyState icon="inbox" title="No issues in this version" />
  const count = (re: RegExp) => (buckets.data?.buckets ?? []).filter((b) => re.test(b.name)).reduce((a, b) => a + b.value, 0)
  const done = count(/done|complete/i), doing = count(/progress/i), todo = total - done - doing
  return (
    <div className="space-y-3">
      <Kpi value={`${Math.round((done / total) * 100)}%`} caption={`of ${total} issues done in ${meta.data?.name}`} />
      <div className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-2)]" role="img" aria-label={`${done} done, ${doing} in progress, ${todo} to do`}>
        <div className="bg-[var(--success)]" style={{ width: `${(done / total) * 100}%` }} /><div className="bg-[var(--brand-500)]" style={{ width: `${(doing / total) * 100}%` }} />
      </div>
      <p className="text-xs text-[var(--text-tertiary)]">{done} done · {doing} in progress · {todo} to do</p>
    </div>
  )
}
