'use client'

import { useTerm } from '@/hooks/use-term'
import { TimeInStatusReportView } from '@/components/time-in-status-report'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '@/components/empty-state'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { LineChart } from '@/components/line-chart'
import { BurnupView, ReleaseBurndownView, VersionReportView } from '@/components/agile-reports'

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

type Unit = 'issues' | 'hours' | 'points'
type Report = 'burndown' | 'burnup' | 'release' | 'version' | 'epic-burndown' | 'sprint' | 'velocity' | 'cfd' | 'control' | 'epics' | 'tis'
type BurnupScope = 'sprint' | 'version' | 'epic'
const LABELS: Record<Report, string> = {
  burndown: 'Burndown', burnup: 'Burnup', release: 'Release burndown', version: 'Version report', 'epic-burndown': 'Epic burndown', sprint: 'Sprint report', velocity: 'Velocity', cfd: 'Cumulative flow', control: 'Control chart', epics: 'Epic report', tis: 'Average time in status',
}
const API = '/rest/agile/1.0'

export default function ReportsPage() {
  const { t } = useTerm()
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => get<{ values: Array<{ id: string; name: string; type: string }> }>('/rest/api/2/board') })
  const [boardId, setBoardId] = useState('')
  const [report, setReport] = useState<Report>('burndown')
  const [burnupScope, setBurnupScope] = useState<BurnupScope>('sprint')
  const [tisScope, setTisScope] = useState<'board' | 'sprint'>('board')
  const [versionChoice, setVersionChoice] = useState('')
  const [epicChoice, setEpicChoice] = useState('')
  const [lookback, setLookback] = useState('14')
  const [sprintId, setSprintId] = useState('')
  const [unitChoice, setUnitChoice] = useState<Unit | null>(null)
  // Deep links from the versions page: /reports?report=version&board=1&version=7 (read after mount: no hydration mismatch)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const r = q.get('report') as Report | null
    if (r && r in LABELS) setReport(r)
    if (q.get('board')) setBoardId(q.get('board')!)
    if (q.get('version')) setVersionChoice(q.get('version')!)
  }, [])
  const bid = boardId || boards.data?.values[0]?.id || ''
  // Story points are the default as soon as the board's project has an estimated issue.
  const units = useQuery({
    queryKey: ['report-units', bid], enabled: !!bid,
    queryFn: () => get<{ hasPoints: boolean; defaultUnit: Unit }>(`${API}/board/${bid}/report/units`),
  })
  const unit: Unit = unitChoice ?? units.data?.defaultUnit ?? 'issues'
  const unitLabel = unit === 'points' ? 'story points' : unit === 'hours' ? 'hours' : 'issues'

  const sprints = useQuery({
    queryKey: ['sprints', bid], enabled: !!bid,
    queryFn: () => get<{ values: Array<{ id: number; name: string; state: string }> }>(`${API}/board/${bid}/sprint`),
  })
  // The running sprint first (it is the one people look at), otherwise the latest.
  const sid = sprintId || String((sprints.data?.values.find((s) => s.state === 'active') ?? sprints.data?.values.at(-1))?.id ?? '')
  const scope: BurnupScope = report === 'burnup' ? burnupScope : report === 'version' || report === 'release' ? 'version' : report === 'epic-burndown' ? 'epic' : 'sprint'
  const isTis = report === 'tis'
  const needsSprint = report === 'burndown' || report === 'sprint' || (report === 'burnup' && scope === 'sprint') || (isTis && tisScope === 'sprint')
  const needsVersion = report === 'release' || report === 'version' || (report === 'burnup' && scope === 'version')
  const needsEpic = report === 'epic-burndown' || (report === 'burnup' && scope === 'epic')
  const versions = useQuery({
    queryKey: ['report-versions', bid], enabled: !!bid && needsVersion,
    queryFn: () => get<{ versions: Array<{ id: number; name: string; released: boolean }> }>(`${API}/board/${bid}/report/versions`),
  })
  const epics = useQuery({
    queryKey: ['report-epic-list', bid], enabled: !!bid && needsEpic,
    queryFn: () => get<{ epics: Array<{ key: string; summary: string }> }>(`${API}/board/${bid}/report/epics?unit=issues`),
  })
  const vid = versionChoice || String(versions.data?.versions.find((v) => !v.released)?.id ?? versions.data?.versions[0]?.id ?? '')
  const eid = epicChoice || epics.data?.epics[0]?.key || ''
  const endpoint = report === 'release' ? 'release-burndown' : report
  const extra = [
    report === 'burnup' ? `&scope=${burnupScope}` : '',
    needsSprint ? `&sprintId=${sid}` : '',
    needsVersion ? `&versionId=${vid}` : '',
    needsEpic ? `&epicKey=${encodeURIComponent(eid)}` : '',
    report === 'release' || report === 'epic-burndown' || report === 'version' ? `&lookback=${lookback}` : '',
  ].join('')
  const url = `${API}/board/${bid}/report/${endpoint}?unit=${unit}${extra}`
  const ready = !isTis && !!bid && (!needsSprint || !!sid) && (!needsVersion || !!vid) && (!needsEpic || !!eid)
  const data = useQuery({ queryKey: ['report', url], enabled: ready, queryFn: () => get<any>(url), retry: false })

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title="Reports" description="Burndown, velocity, cumulative flow and more, per board." />
        <div className={`flex flex-wrap gap-3 items-end ${boards.data?.values.length === 0 ? 'hidden' : ''}`}>
          <label className="text-sm space-y-1 block">Board
            <select className="veqsio-input block" value={bid} onChange={(e) => { setBoardId(e.target.value); setSprintId('') }}>
              {boards.data?.values.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="text-sm space-y-1 block">Report
            <select className="veqsio-input block" value={report} onChange={(e) => setReport(e.target.value as Report)}>
              {(Object.keys(LABELS) as Report[]).map((r) => <option key={r} value={r}>{LABELS[r]}</option>)}
            </select>
          </label>
          {isTis && (
            <label className="text-sm space-y-1 block">Scope
              <select className="veqsio-input block" value={tisScope} onChange={(e) => setTisScope(e.target.value as 'board' | 'sprint')}>
                <option value="board">Whole board / project</option>
                <option value="sprint">One sprint</option>
              </select>
            </label>
          )}
          {needsSprint && (
            <label className="text-sm space-y-1 block">Sprint
              <select className="veqsio-input block" value={sid} onChange={(e) => setSprintId(e.target.value)}>
                {sprints.data?.values.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.state})</option>)}
              </select>
            </label>
          )}
          {report === 'burnup' && (
            <label className="text-sm space-y-1 block">Scope
              <select className="veqsio-input block" value={burnupScope} onChange={(e) => setBurnupScope(e.target.value as BurnupScope)}>
                <option value="sprint">Sprint</option>
                <option value="version">Version</option>
                <option value="epic">Epic</option>
              </select>
            </label>
          )}
          {needsVersion && (
            <label className="text-sm space-y-1 block">Version
              <select className="veqsio-input block" value={vid} onChange={(e) => setVersionChoice(e.target.value)}>
                {versions.data?.versions.map((v) => <option key={v.id} value={v.id}>{v.name}{v.released ? ' (released)' : ''}</option>)}
              </select>
            </label>
          )}
          {needsEpic && (
            <label className="text-sm space-y-1 block">Epic
              <select className="veqsio-input block" value={eid} onChange={(e) => setEpicChoice(e.target.value)}>
                {epics.data?.epics.map((e) => <option key={e.key} value={e.key}>{e.key} {e.summary}</option>)}
              </select>
            </label>
          )}
          {(report === 'release' || report === 'epic-burndown' || report === 'version') && (
            <label className="text-sm space-y-1 block">Velocity window
              <select className="veqsio-input block" value={lookback} onChange={(e) => setLookback(e.target.value)}>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
                <option value="60">Last 60 days</option>
              </select>
            </label>
          )}
          {isTis && (
            <label className="text-sm space-y-1 block">Scope
              <select className="veqsio-input block" value={tisScope} onChange={(e) => setTisScope(e.target.value as 'board' | 'sprint')}>
                <option value="board">Whole board</option>
                <option value="sprint">Selected sprint</option>
              </select>
            </label>
          )}
          {!isTis && <label className="text-sm space-y-1 block">Unit
            <select className="veqsio-input block" value={unit} onChange={(e) => setUnitChoice(e.target.value as Unit)}>
              <option value="points">Story points</option>
              <option value="issues">{t('Issue count')}</option>
              <option value="hours">Estimate (hours)</option>
            </select>
          </label>}
        </div>

        <div className="veqsio-card p-4">
          {boards.data?.values.length === 0 && <EmptyState icon="inbox" title="No boards yet" description="Reports are built from a board. Create a board and they appear here." />}
          {isTis && bid && <TimeInStatusReportView boardId={bid} sprintId={tisScope === 'sprint' ? sid : undefined} />}
          {!isTis && data.isLoading && <Spinner />}
          {!isTis && data.error && <p role="alert" className="text-[var(--error)]">{(data.error as Error).message}</p>}
          {!isTis && data.data && unit !== 'issues' && report !== 'cfd' && report !== 'control' && data.data.unestimated !== undefined && (
            <p className="text-sm text-[var(--text-secondary)] mb-3" data-testid="unestimated-note">
              Values are in {unitLabel}.
              {data.data.unestimated > 0 && <> {data.data.unestimated} issue{data.data.unestimated === 1 ? ' has' : 's have'} no estimate and count as 0.</>}
            </p>
          )}
          {!isTis && data.data && <ReportView report={report} data={data.data} unit={unit} />}
        </div>
      </div>
    </AppLayout>
  )
}

function ReportView({ report, data, unit }: { report: Report; data: any; unit: Unit }) {
  switch (report) {
    case 'tis':
      return null
    case 'burnup':
      return <BurnupView data={data} unit={unit} />
    case 'release':
      return <ReleaseBurndownView data={data} unit={unit} title={`Release burndown ${data.version?.name ?? ''}`} />
    case 'epic-burndown':
      return <ReleaseBurndownView data={data} unit={unit} title={`Epic burndown ${data.epic?.key ?? ''}`} />
    case 'version':
      return <VersionReportView data={data} unit={unit} />
    case 'burndown':
      return <LineChart ariaLabel="Sprint burndown" labels={data.points.map((p: any) => p.date)} series={[
        { name: 'Ideal', color: 'var(--text-tertiary)', dashed: true, values: data.points.map((p: any) => p.ideal) },
        { name: 'Remaining', color: 'var(--brand-500)', values: data.points.map((p: any) => (Number.isFinite(p.remaining) ? p.remaining : null)) },
      ]} />
    case 'cfd':
      return <LineChart ariaLabel="Cumulative flow" stacked labels={data.points.map((p: any) => p.date)} series={[
        { name: 'Done', color: '#16A06A', values: data.points.map((p: any) => p.done) },
        { name: 'In progress', color: '#3D6AF0', values: data.points.map((p: any) => p.in_progress) },
        { name: 'To do', color: '#98A2B3', values: data.points.map((p: any) => p.todo) },
      ]} />
    case 'sprint':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Committed" value={data.committed} /><Stat label="Completed" value={data.completed} /><Stat label="Not completed" value={data.incomplete} />
          </div>
          <KeyList title="Completed" keys={data.completedIssues} /><KeyList title="Not completed" keys={data.incompleteIssues} />
          {data.flaggedIssues?.length > 0 && <KeyList title="Flagged (impediments)" keys={data.flaggedIssues} />}
          {data.scopeChanges?.length > 0 && <KeyList title="Scope changes after the start" keys={data.scopeChanges.map((c: any) => `${c.kind === 'added' ? '+' : '-'}${c.key}`)} />}
        </div>
      )
    case 'velocity':
      return data.sprints.length === 0 ? <p className="text-[var(--text-tertiary)]">No closed sprints yet.</p> : (
        <div className="space-y-3">
          <p className="text-sm">Average velocity: <strong>{data.averageVelocity?.toFixed(1)}</strong></p>
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Sprint</th><th>Committed</th><th>Completed</th><th className="w-1/2"></th></tr></thead>
            <tbody>{data.sprints.map((s: any) => (
              <tr key={s.sprintId}><td>{s.name}</td><td>{s.committed}</td><td>{s.completed}</td>
                <td><div className="h-3 bg-[var(--surface-3)] rounded"><div className="h-3 bg-[var(--brand-500)] rounded" style={{ width: `${s.committed ? (s.completed / s.committed) * 100 : 0}%` }} /></div></td></tr>
            ))}</tbody></table>
        </div>
      )
    case 'control':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Average cycle (days)" value={fmt(data.averageCycleDays)} /><Stat label="Median" value={fmt(data.medianCycleDays)} /><Stat label="85th percentile" value={fmt(data.p85CycleDays)} />
          </div>
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Issue</th><th>Done</th><th>Cycle (d)</th><th>Lead (d)</th></tr></thead>
            <tbody>{data.points.slice(-50).map((p: any) => <tr key={p.key}><td>{p.key}</td><td>{new Date(p.doneAt).toLocaleDateString()}</td><td>{fmt(p.cycleDays)}</td><td>{fmt(p.leadDays)}</td></tr>)}</tbody></table>
        </div>
      )
    case 'epics':
      return data.epics.length === 0 ? <p className="text-[var(--text-tertiary)]">No epics in this project.</p> : (
        <ul className="space-y-3">{data.epics.map((e: any) => (
          <li key={e.key}>
            <div className="flex justify-between text-sm"><span><strong>{e.key}</strong> {e.summary}</span><span>{e.percentDone}%</span></div>
            <div className="h-2 bg-[var(--surface-3)] rounded overflow-hidden flex" role="img" aria-label={`${e.done} done, ${e.inProgress} in progress, ${e.todo} to do`}>
              <div style={{ width: `${e.total ? (e.done / e.total) * 100 : 0}%`, background: '#16A06A' }} />
              <div style={{ width: `${e.total ? (e.inProgress / e.total) * 100 : 0}%`, background: '#3D6AF0' }} />
            </div>
          </li>))}</ul>
      )
  }
}

const fmt = (n: number | null) => (n === null || n === undefined ? '—' : n.toFixed(1))
const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded border border-[var(--surface-3)] p-3"><div className="text-2xl font-semibold">{value}</div><div className="text-xs text-[var(--text-secondary)]">{label}</div></div>
)
const KeyList = ({ title, keys }: { title: string; keys: string[] }) => (
  <div><h3 className="text-sm font-medium">{title} ({keys.length})</h3><p className="text-sm text-[var(--text-secondary)]">{keys.join(', ') || '—'}</p></div>
)
