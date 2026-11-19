'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { milestoneMarker } from '@/lib/initiatives'
import { DAY, PX_PER_DAY, applyDrag, barGeometry, computeWindow, dayOf, headerTicks, ymd, type DragMode, type Zoom } from '@/lib/roadmap-layout'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface RoadmapItem {
  key: string; summary: string; issueType: string; category: 'todo' | 'in_progress' | 'done'; isEpic: boolean
  start: string; end: string | null; explicitStart: string | null; dueDate: string | null
  progress: { children: { done: number; total: number }; points: { done: number; total: number }; percent: number }
}
interface Roadmap {
  project: { id: number; key: string; name: string }
  items: RoadmapItem[]
  versions: Array<{ id: number; name: string; startDate: string | null; releaseDate: string | null; released: boolean }>
  milestones?: Array<{ id: number; name: string; targetDate: string; state: string; percent: number; issueCount: number }>
  dependencies: Array<{ from: string; to: string; kind?: 'blocks' | 'starts_before' | 'finishes_before'; conflict?: boolean; message?: string | null }>
}

const ROW = 36
const LABEL_W = 260
const COLORS = { todo: '#9e9e9e', in_progress: '#1976d2', done: '#2e7d32' } as const

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.json()
}

export default function RoadmapPage() {
  const ms = useMultiSort()
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Array<{ key: string; name: string }>>('/rest/api/2/project') })
  const [projectKey, setProjectKeyState] = useState('')
  // the project chosen last time is the one to open next time (per browser)
  useEffect(() => { try { const v = localStorage.getItem('roadmap-project'); if (v) setProjectKeyState(v) } catch { /* storage unavailable */ } }, [])
  const setProjectKey = (v: string) => { setProjectKeyState(v); try { localStorage.setItem('roadmap-project', v) } catch { /* ignore */ } }
  const [zoom, setZoom] = useState<Zoom>('months')
  const [view, setView] = useState<'timeline' | 'table'>('timeline')
  const [orphans, setOrphans] = useState(false)
  const key = projectKey || projects.data?.[0]?.key || ''

  const queryKey = ['roadmap', key, orphans]
  const roadmap = useQuery({
    queryKey, enabled: !!key,
    queryFn: () => api<Roadmap>(`/rest/agile/1.0/project/${encodeURIComponent(key)}/roadmap?includeOrphans=${orphans}`),
  })

  // Optimistic reschedule with rollback on error
  const reschedule = useMutation({
    mutationFn: ({ issueKey, startDate, dueDate }: { issueKey: string; startDate?: string | null; dueDate?: string | null }) =>
      api(`/rest/agile/1.0/roadmap/issue/${issueKey}/dates`, { method: 'PUT', body: JSON.stringify({ startDate, dueDate }) }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey })
      const prev = qc.getQueryData<Roadmap>(queryKey)
      if (prev) {
        qc.setQueryData<Roadmap>(queryKey, {
          ...prev,
          items: prev.items.map((i) => i.key === v.issueKey ? { ...i, start: v.startDate ? `${v.startDate}T00:00:00.000Z` : i.start, end: v.dueDate ? `${v.dueDate}T00:00:00.000Z` : i.end } : i),
        })
      }
      return { prev }
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); toast((e as Error).message || 'Could not reschedule', 'error') },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })

  const ppd = PX_PER_DAY[zoom]
  const data = roadmap.data
  const win = useMemo(() => computeWindow(data?.items ?? [], [...(data?.versions ?? []), ...(data?.milestones ?? []).map((m) => ({ startDate: null, releaseDate: m.targetDate }))]), [data])
  const width = (win.endDay - win.startDay + 1) * ppd
  const ticks = useMemo(() => headerTicks(win.startDay, win.endDay, ppd, zoom), [win, ppd, zoom])
  const todayX = (dayOf(new Date()) - win.startDay) * ppd + ppd / 2
  const rowIndex = new Map((data?.items ?? []).map((i, idx) => [i.key, idx]))
  const bodyTop = 0
  const milestones = data?.milestones ?? []
  const versionRows = data?.versions.length ? 1 : 0
  const milestoneRows = milestones.length ? 1 : 0

  // ---- drag handling (pointer events) ----
  const drag = useRef<{ key: string; mode: DragMode; x0: number; s: number; e: number } | null>(null)
  const [preview, setPreview] = useState<{ key: string; startDay: number; endDay: number } | null>(null)

  const onDown = (e: React.PointerEvent, item: RoadmapItem, mode: DragMode) => {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const s = dayOf(item.start)
    const en = item.end ? dayOf(item.end) : s + 6
    drag.current = { key: item.key, mode, x0: e.clientX, s, e: en }
    setPreview({ key: item.key, startDay: s, endDay: en })
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setPreview({ key: d.key, ...applyDrag(d.mode, d.s, d.e, e.clientX - d.x0, ppd) })
  }
  const onUp = () => {
    const d = drag.current, p = preview
    drag.current = null; setPreview(null)
    if (!d || !p || (p.startDay === d.s && p.endDay === d.e)) return
    reschedule.mutate({ issueKey: d.key, startDate: ymd(p.startDay), dueDate: ymd(p.endDay) })
  }

  const itemFor = (i: RoadmapItem) => preview?.key === i.key ? { ...i, start: new Date(preview.startDay * DAY).toISOString(), end: new Date(preview.endDay * DAY).toISOString() } : i

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title="Roadmap" description="Epics and versions on a timeline, with dependencies." />
        <div className="flex flex-wrap items-end gap-3">
          <div className="contents">
            <label className="text-sm block">Project
              <select className="veqsio-input block" value={key} onChange={(e) => setProjectKey(e.target.value)}>
                {projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
              </select>
            </label>
            <label className="text-sm block">Zoom
              <select className="veqsio-input block" value={zoom} onChange={(e) => setZoom(e.target.value as Zoom)}>
                <option value="weeks">Weeks</option><option value="months">Months</option><option value="quarters">Quarters</option>
              </select>
            </label>
            <label className="text-sm flex items-center gap-2 pb-2"><input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> Include issues without an epic</label>
            <div role="group" aria-label="View" className="flex gap-1">
              <button className={view === 'timeline' ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</button>
              <button className={view === 'table' ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
            </div>
          </div>
        </div>

        {roadmap.isLoading && <Spinner />}
        {roadmap.error && <p role="alert" className="text-[var(--error)]">{(roadmap.error as Error).message}</p>}
        {data && data.items.length === 0 && <p className="text-[var(--text-tertiary)]">No epics in this project yet. Create an epic to see it on the roadmap.</p>}

        {data && data.dependencies.some((d) => d.conflict) && (
          <div role="alert" className="rounded-lg border border-[#C9372C] bg-[#C9372C14] p-3 text-sm space-y-1">
            <p className="font-medium text-[#C9372C]">Schedule conflicts</p>
            <ul className="list-disc pl-5">
              {data.dependencies.filter((d) => d.conflict).map((d) => (
                <li key={`${d.from}-${d.to}-${d.kind}`}>
                  <Link href={`/issues/${d.from}`} className="font-mono text-[var(--brand-500)] hover:underline">{d.from}</Link>
                  {d.kind === 'starts_before' ? ' should start before ' : ' should finish before '}
                  <Link href={`/issues/${d.to}`} className="font-mono text-[var(--brand-500)] hover:underline">{d.to}</Link>
                  {d.message ? ` (${d.message.toLowerCase()})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {data && data.items.length > 0 && view === 'timeline' && (
          <div className="veqsio-card p-0 overflow-hidden">
            <div className="flex">
              <div className="shrink-0 border-r border-[var(--surface-3)]" style={{ width: LABEL_W }}>
                <div className="h-8 border-b border-[var(--surface-3)] px-3 text-xs flex items-center text-[var(--text-tertiary)]">Epic</div>
                {data.items.map((i) => (
                  <div key={i.key} className="px-3 flex items-center gap-2 border-b border-[var(--surface-2)] text-sm" style={{ height: ROW }}>
                    <Link href={`/issues/${i.key}`} className="font-mono text-xs text-[var(--brand-500)] hover:underline">{i.key}</Link>
                    <span className="truncate" title={i.summary}>{i.summary}</span>
                  </div>
                ))}
                {data.versions.length > 0 && <div className="px-3 flex items-center text-xs text-[var(--text-tertiary)]" style={{ height: ROW }}>Releases</div>}
                {milestones.length > 0 && <div className="px-3 flex items-center text-xs text-[var(--text-tertiary)]" style={{ height: ROW }}>Milestones</div>}
              </div>
              <div className="overflow-x-auto flex-1">
                <div className="relative" style={{ width, height: 32 + ROW * data.items.length + (versionRows + milestoneRows) * ROW }} onPointerMove={onMove} onPointerUp={onUp}>
                  <svg className="absolute inset-0 pointer-events-none" width={width} height="100%" aria-hidden>
                    {ticks.map((t) => <line key={t.x} x1={t.x} x2={t.x} y1={0} y2="100%" stroke="var(--surface-3)" />)}
                    <line x1={todayX} x2={todayX} y1={0} y2="100%" stroke="#d32f2f" strokeWidth={1.5} />
                    <defs>
                      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#757575" /></marker>
                      <marker id="arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#C9372C" /></marker>
                    </defs>
                    {data.dependencies.map((d, idx) => {
                      const a = rowIndex.get(d.from), b = rowIndex.get(d.to)
                      if (a === undefined || b === undefined) return null
                      const A = barGeometry(itemFor(data.items[a]), win.startDay, ppd), B = barGeometry(itemFor(data.items[b]), win.startDay, ppd)
                      const x1 = A.left + A.width, y1 = bodyTop + 32 + a * ROW + ROW / 2, x2 = B.left, y2 = 32 + b * ROW + ROW / 2
                      const bad = !!d.conflict
                      return <path key={idx} d={`M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`} fill="none" stroke={bad ? '#C9372C' : '#757575'} strokeWidth={bad ? 2 : 1.2} strokeDasharray={d.kind === 'starts_before' ? '4 3' : undefined} markerEnd={bad ? 'url(#arrow-bad)' : 'url(#arrow)'} />
                    })}
                  </svg>
                  <div className="absolute inset-x-0 top-0 h-8 border-b border-[var(--surface-3)]">
                    {ticks.map((t) => <span key={t.x} className={`absolute top-0 h-8 flex items-center pl-1 text-xs ${t.major ? 'font-medium' : 'text-[var(--text-tertiary)]'}`} style={{ left: t.x }}>{t.label}</span>)}
                  </div>
                  {data.items.map((raw, idx) => {
                    const i = itemFor(raw)
                    const g = barGeometry(i, win.startDay, ppd)
                    const color = COLORS[i.category]
                    return (
                      <div key={i.key} className="absolute" style={{ top: 32 + idx * ROW + 6, left: g.left, width: g.width, height: ROW - 12 }}>
                        <div
                          role="img" aria-label={`${i.key}: ${i.summary}, ${i.progress.percent}% done, ${ymd(dayOf(i.start))} to ${i.end ? ymd(dayOf(i.end)) : 'no end date'}`}
                          className="relative h-full rounded cursor-grab active:cursor-grabbing select-none touch-none overflow-hidden"
                          style={{ background: `${color}33`, border: `1px ${g.open ? 'dashed' : 'solid'} ${color}` }}
                          onPointerDown={(e) => onDown(e, raw, 'move')}
                          title={`${i.key} · ${i.progress.percent}% done${g.open ? ' · no end date (drag the right edge to set one)' : ''}`}
                        >
                          <div className="absolute inset-y-0 left-0" style={{ width: `${i.progress.percent}%`, background: `${color}88` }} />
                          <span className="relative px-2 text-xs leading-5 whitespace-nowrap">{i.progress.percent}%</span>
                          <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" onPointerDown={(e) => onDown(e, raw, 'resize-start')} />
                          <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" onPointerDown={(e) => onDown(e, raw, 'resize-end')} />
                        </div>
                      </div>
                    )
                  })}
                  {data.versions.length > 0 && (
                    <div className="absolute inset-x-0" style={{ top: 32 + ROW * data.items.length }}>
                      {data.versions.filter((v) => v.releaseDate).map((v) => {
                        const x = (dayOf(v.releaseDate!) - win.startDay) * ppd
                        return (
                          <div key={v.id} className="absolute flex items-center gap-1 text-xs" style={{ left: x - 7, top: 8 }} title={`${v.name} — ${v.releaseDate}${v.released ? ' (released)' : ''}`}>
                            <span className="inline-block w-3.5 h-3.5 rotate-45" style={{ background: v.released ? '#2e7d32' : '#f9a825' }} aria-hidden />
                            <span className="whitespace-nowrap">{v.name}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {milestones.length > 0 && (
                    <div className="absolute inset-x-0" style={{ top: 32 + ROW * (data.items.length + versionRows) }}>
                      {milestones.map((m) => {
                        const mk = milestoneMarker(m, win.startDay, ppd)
                        return (
                          <div key={m.id} role="img" aria-label={mk.label} className="absolute flex items-center gap-1 text-xs" style={{ left: mk.x - 6, top: 8 }} title={mk.label}>
                            <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden><path d="M1 1 V13 M1 2 H11 L8 5.5 L11 9 H1" fill={mk.color} stroke={mk.color} strokeWidth="1.5" /></svg>
                            <span className="whitespace-nowrap">{m.name}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="px-3 py-2 text-xs text-[var(--text-tertiary)] border-t border-[var(--surface-3)]">
              Drag a bar to move it, drag its edges to change start or end. Dashed bars have no end date yet. The red line is today. A keyboard-friendly version is in the Table view.
            </p>
          </div>
        )}

        {data && data.items.length > 0 && view === 'table' && (
          <div className="veqsio-card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="veqsio-table-header text-left"><SortableTh {...ms.th('key')} className="px-3 py-2">Key</SortableTh><SortableTh {...ms.th('name')} className="px-3 py-2">Summary</SortableTh><SortableTh {...ms.th('progress')} className="px-3 py-2">Progress</SortableTh><SortableTh {...ms.th('start')} className="px-3 py-2">Start</SortableTh><SortableTh {...ms.th('due')} className="px-3 py-2">Due</SortableTh></tr></thead>
              <tbody>
                {ms.sort(data.items, { key: (i) => i.key, name: (i) => i.summary, progress: (i) => i.progress.percent, start: (i) => i.start, due: (i) => i.end }).map((i) => (
                  <tr key={i.key} className="veqsio-table-row">
                    <td className="px-3 py-2"><Link href={`/issues/${i.key}`} className="text-[var(--brand-500)] hover:underline">{i.key}</Link></td>
                    <td className="px-3 py-2">{i.summary}</td>
                    <td className="px-3 py-2">{i.progress.percent}%</td>
                    <td className="px-3 py-2"><input aria-label={`Start date of ${i.key}`} type="date" className="veqsio-input" defaultValue={ymd(dayOf(i.start))} onBlur={(e) => e.target.value && e.target.value !== ymd(dayOf(i.start)) && reschedule.mutate({ issueKey: i.key, startDate: e.target.value })} /></td>
                    <td className="px-3 py-2"><input aria-label={`Due date of ${i.key}`} type="date" className="veqsio-input" defaultValue={i.end ? ymd(dayOf(i.end)) : ''} onBlur={(e) => e.target.value && e.target.value !== (i.end ? ymd(dayOf(i.end)) : '') && reschedule.mutate({ issueKey: i.key, dueDate: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
