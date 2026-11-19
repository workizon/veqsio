'use client'

import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '@/components/empty-state'
import { ChartSkeleton } from '@/components/charts/chart-kit'
import { LineChart } from '@/components/line-chart'

type Config = Record<string, unknown>

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? `HTTP ${res.status}`)
  return res.json()
}

const unit = (c: Config) => (c.unit === 'hours' || c.unit === 'points' ? (c.unit as string) : 'issues')
const board = (c: Config) => (c.boardId ? String(c.boardId) : '')
const NoBoard = () => <EmptyState icon="inbox" title="Choose a board" description="Open the gadget settings and pick a board." />

/** Closed sprints of a board: committed versus completed, with the average. Reuses the report endpoint. */
function Velocity({ config }: { config: Config }) {
  const b = board(config)
  const q = useQuery({
    enabled: !!b, queryKey: ['gadget-velocity', b, config.count, unit(config)],
    queryFn: () => get<{ sprints: { sprintId: number; name: string; committed: number; completed: number }[]; averageVelocity: number | null }>(`/rest/agile/1.0/board/${b}/report/velocity?count=${Number(config.count) || 6}&unit=${unit(config)}`),
  })
  if (!b) return <NoBoard />
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <p role="alert" className="p-3 text-body-sm text-[var(--error)]">{(q.error as Error).message}</p>
  const d = q.data!
  if (!d.sprints.length) return <EmptyState icon="inbox" title="No closed sprints yet" />
  return (
    <div className="space-y-2">
      <p className="text-body-sm">Average velocity: <strong>{d.averageVelocity?.toFixed(1) ?? '—'}</strong> {unit(config)}</p>
      <ul className="space-y-1.5">
        {d.sprints.map((s) => (
          <li key={s.sprintId} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-body-sm">
            <span className="truncate" title={s.name}>{s.name}</span>
            <span className="h-2 rounded-full bg-[var(--surface-3)] overflow-hidden" role="img" aria-label={`${s.completed} of ${s.committed} completed`}><span className="block h-full rounded-full bg-[var(--brand-500)]" style={{ width: `${s.committed ? Math.min(100, (s.completed / s.committed) * 100) : 0}%` }} /></span>
            <span className="tabular-nums text-[var(--text-secondary)]">{s.completed}/{s.committed}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Burndown({ config }: { config: Config }) {
  const b = board(config)
  const sprint = useQuery({
    enabled: !!b && !config.sprintId, queryKey: ['gadget-active-sprint', b],
    queryFn: () => get<{ values: { id: number; name: string }[] }>(`/rest/agile/1.0/board/${b}/sprint?state=active`).then((r) => r.values?.[0]?.id ?? null),
  })
  const sid = config.sprintId ? String(config.sprintId) : sprint.data ? String(sprint.data) : ''
  const q = useQuery({
    enabled: !!b && !!sid, queryKey: ['gadget-burndown', b, sid, unit(config)],
    queryFn: () => get<{ sprint: { name: string }; points: { date: string; ideal: number; remaining: number }[] }>(`/rest/agile/1.0/board/${b}/report/burndown?sprintId=${sid}&unit=${unit(config)}`),
  })
  if (!b) return <NoBoard />
  if (sprint.isLoading || q.isLoading) return <ChartSkeleton />
  if (!sid) return <EmptyState icon="inbox" title="No active sprint" />
  if (q.error) return <p role="alert" className="p-3 text-body-sm text-[var(--error)]">{(q.error as Error).message}</p>
  const d = q.data!
  return (
    <div>
      <p className="text-caption text-[var(--text-tertiary)] mb-1">{d.sprint.name}</p>
      <LineChart ariaLabel="Sprint burndown" height={200} labels={d.points.map((p) => p.date)} series={[
        { name: 'Ideal', color: 'var(--text-tertiary)', dashed: true, values: d.points.map((p) => p.ideal) },
        { name: 'Remaining', color: 'var(--brand-500)', values: d.points.map((p) => (Number.isFinite(p.remaining) ? p.remaining : null)) },
      ]} />
    </div>
  )
}

function Flow({ config }: { config: Config }) {
  const b = board(config)
  const q = useQuery({
    enabled: !!b, queryKey: ['gadget-cfd', b, config.days],
    queryFn: () => get<{ points: { date: string; done: number; in_progress: number; todo: number }[] }>(`/rest/agile/1.0/board/${b}/report/cfd?days=${Number(config.days) || 30}`),
  })
  if (!b) return <NoBoard />
  if (q.isLoading) return <ChartSkeleton />
  if (q.error) return <p role="alert" className="p-3 text-body-sm text-[var(--error)]">{(q.error as Error).message}</p>
  const p = q.data!.points
  return (
    <LineChart ariaLabel="Cumulative flow" stacked height={220} labels={p.map((x) => x.date)} series={[
      { name: 'Done', color: '#16A06A', values: p.map((x) => x.done) },
      { name: 'In progress', color: '#3D6AF0', values: p.map((x) => x.in_progress) },
      { name: 'To do', color: '#98A2B3', values: p.map((x) => x.todo) },
    ]} />
  )
}

export function AgileGadget({ type, config }: { type: string; config: Config }) {
  if (type === 'velocity') return <Velocity config={config} />
  if (type === 'sprint-burndown') return <Burndown config={config} />
  if (type === 'cumulative-flow') return <Flow config={config} />
  return null
}
