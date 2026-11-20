'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { MonthCalendar } from '@/components/month-calendar'
import { EmptyState } from '@/components/empty-state'
import type { ApiIssue } from '@/hooks/use-issues'
import { groupByDate, isoDate, monthGrid, shiftMonth } from '@/lib/calendar-grid'
import { PX_PER_DAY, barGeometry, computeWindow, dayOf, headerTicks } from '@/lib/roadmap-layout'
import {
  COLUMN_LABELS, SORTABLE, cellText, issuesOf, timelineItems,
  type ColumnId, type ViewConfig, type ViewGroup,
} from '@/lib/views'

export interface LayoutProps {
  issues: ApiIssue[]
  groups: ViewGroup[]
  config: ViewConfig
  onSort?: (field: string) => void
}

const byIdMap = (issues: ApiIssue[]) => new Map(issues.map((i) => [i.id, i]))

function Cell({ issue, col }: { issue: ApiIssue; col: ColumnId }) {
  const { tr } = useI18n();

  switch (col) {
    case 'key': return <Link href={`/issues/${issue.key}`} className="font-medium text-[var(--brand-600)] hover:underline">{issue.key}</Link>
    case 'summary': return <span className="truncate" title={issue.fields.summary}>{issue.fields.summary}</span>
    case 'status': return <StatusBadge status={issue.fields.status.name} />
    case 'priority': return issue.fields.priority ? <PriorityBadge priority={issue.fields.priority.name} /> : <span className="text-[var(--text-tertiary)]">{tr('None')}</span>
    default: return <span className="truncate">{cellText(issue, col) || <span className="text-[var(--text-tertiary)]">-</span>}</span>
  }
}

/** Walks groups (and sub-groups) and renders `body` for each leaf bucket under its headings. */
function Grouped({ groups, config, issues, render }: { groups: ViewGroup[]; config: ViewConfig; issues: ApiIssue[]; render: (list: ApiIssue[], key: string) => React.ReactNode }) {
  const byId = useMemo(() => byIdMap(issues), [issues])
  if (config.groupBy === 'none') return <>{render(issues, 'all')}</>
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.key} aria-label={`${g.label}, ${g.count} issues`}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            {g.label} <span className="rounded-full bg-[var(--surface-2)] px-2 text-xs font-normal text-[var(--text-secondary)]">{g.count}</span>
          </h3>
          {g.subGroups ? (
            <div className="space-y-3 pl-3">
              {g.subGroups.map((s) => (
                <div key={s.key}>
                  <h4 className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                    {s.label} <span className="rounded-full bg-[var(--surface-2)] px-2 font-normal">{s.count}</span>
                  </h4>
                  {render(issuesOf(s.issueIds, byId), `${g.key}/${s.key}`)}
                </div>
              ))}
            </div>
          ) : render(issuesOf(g.issueIds, byId), g.key)}
        </section>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function ListLayout(props: LayoutProps) {
  const { tr } = useI18n();

  const { issues, groups, config } = props
  if (issues.length === 0) return <EmptyState icon="search" title={tr('No issues match this view')} />
  return (
    <Grouped groups={groups} config={config} issues={issues} render={(list, key) => (
      list.length === 0 ? <p className="text-sm text-[var(--text-tertiary)]">{tr('No issues')}</p> : (
        <ul key={key} className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
          {list.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <Link href={`/issues/${i.key}`} className="w-24 shrink-0 font-medium text-[var(--brand-600)] hover:underline">{i.key}</Link>
              <span className="min-w-0 flex-1 truncate" title={i.fields.summary}>{i.fields.summary}</span>
              {config.columns.includes('status') && <StatusBadge status={i.fields.status.name} />}
              {config.columns.includes('priority') && i.fields.priority && <PriorityBadge priority={i.fields.priority.name} />}
              {config.columns.includes('assignee') && <span className="w-32 truncate text-[var(--text-secondary)]">{i.fields.assignee?.displayName ?? tr('Unassigned')}</span>}
            </li>
          ))}
        </ul>
      )
    )} />
  )
}

export function TableLayout(props: LayoutProps) {
  const { tr } = useI18n();

  const { issues, groups, config, onSort } = props
  if (issues.length === 0) return <EmptyState icon="search" title={tr('No issues match this view')} />
  const sort = config.sort[0]
  return (
    <Grouped groups={groups} config={config} issues={issues} render={(list, key) => (
      <div key={key} className="overflow-x-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--surface-1)] text-left text-caption text-[var(--text-secondary)]">
              {config.columns.map((c) => {
                const active = sort?.field === c
                return (
                  <th key={c} scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined} className="px-3 py-2 font-medium">
                    {SORTABLE.has(c) && onSort ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]" onClick={() => onSort(c)}>
                        {COLUMN_LABELS[c]}
                        {active && (sort.direction === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                      </button>
                    ) : COLUMN_LABELS[c]}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={config.columns.length} className="px-3 py-3 text-[var(--text-tertiary)]">{tr('No issues')}</td></tr>}
            {list.map((i) => (
              <tr key={i.id} className="border-t border-[var(--surface-3)] hover:bg-[var(--surface-1)]">
                {config.columns.map((c) => <td key={c} className={`px-3 py-2 ${c === 'summary' ? 'max-w-[28rem]' : 'whitespace-nowrap'}`}><Cell issue={i} col={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )} />
  )
}

/** Board: one column per group (status by default), optional swimlanes for the sub-group. */
export function BoardLayout({ issues, groups, config }: LayoutProps) {
  const { tr } = useI18n();

  const byId = useMemo(() => byIdMap(issues), [issues])
  if (issues.length === 0 && groups.length === 0) return <EmptyState icon="search" title={tr('No issues match this view')} />
  // Without a group-by the board falls back to one column holding everything.
  const cols: ViewGroup[] = config.groupBy === 'none' ? [{ key: 'all', label: tr('All issues'), count: issues.length, issueIds: issues.map((i) => i.id) }] : groups
  const lanes = cols.some((c) => c.subGroups) ? [...new Map(cols.flatMap((c) => c.subGroups ?? []).map((s) => [s.key, s.label])).entries()] : [['', ''] as [string, string]]
  return (
    <div className="space-y-4">
      {lanes.map(([laneKey, laneLabel]) => (
        <div key={laneKey}>
          {laneKey && <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{laneLabel}</h3>}
          <div className="flex gap-3 overflow-x-auto pb-2">
            {cols.map((c) => {
              const ids = laneKey ? (c.subGroups?.find((s) => s.key === laneKey)?.issueIds ?? []) : c.issueIds
              const list = issuesOf(ids, byId)
              return (
                <section key={c.key} aria-label={`${c.label}, ${list.length} issues`} className="w-72 shrink-0 rounded-lg bg-[var(--surface-1)] p-2">
                  <h4 className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                    {c.label}<span>{list.length}</span>
                  </h4>
                  <ul className="space-y-2">
                    {list.map((i) => (
                      <li key={i.id} className="rounded-md border border-[var(--surface-3)] bg-[var(--surface-0)] p-2 text-sm">
                        <Link href={`/issues/${i.key}`} className="block hover:underline"><span className="mr-1 text-xs font-medium text-[var(--text-tertiary)]">{i.key}</span>{i.fields.summary}</Link>
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                          <span className="truncate">{i.fields.assignee?.displayName ?? tr('Unassigned')}</span>
                          {i.fields.priority && <PriorityBadge priority={i.fields.priority.name} />}
                        </div>
                      </li>
                    ))}
                    {list.length === 0 && <li className="px-1 text-xs text-[var(--text-tertiary)]">{tr('No issues')}</li>}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Month calendar of the configured date (due date, start date, created, updated) of the issues on this page. */
export function CalendarLayout({ issues, config }: LayoutProps) {
  const { tr } = useI18n();

  const now = new Date()
  const [ym, setYm] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() })
  const weeks = useMemo(() => monthGrid(ym.year, ym.month), [ym])
  const field = config.dateField === 'duedate' ? 'duedate' : config.dateField === 'startdate' ? 'startdate' : config.dateField
  const byDay = useMemo(() => groupByDate(issues, (i) => i.fields[field] as string | null), [issues, field])
  const title = new Date(Date.UTC(ym.year, ym.month, 1)).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const undated = issues.filter((i) => !i.fields[field]).length
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" className="veqsio-btn-secondary" aria-label={tr('Previous month')} onClick={() => setYm((v) => shiftMonth(v.year, v.month, -1))}><ChevronLeft className="h-4 w-4" /></button>
        <span className="min-w-[9rem] text-center font-medium" aria-live="polite">{title}</span>
        <button type="button" className="veqsio-btn-secondary" aria-label={tr('Next month')} onClick={() => setYm((v) => shiftMonth(v.year, v.month, 1))}><ChevronRight className="h-4 w-4" /></button>
        <button type="button" className="veqsio-btn-secondary" onClick={() => setYm({ year: now.getUTCFullYear(), month: now.getUTCMonth() })}>{tr('Today')}</button>
      </div>
      <MonthCalendar weeks={weeks} title={title} byDay={byDay} today={isoDate(now)} />
      {undated > 0 && <p className="text-sm text-[var(--text-secondary)]">{undated === 1 ? tr('{n} issue without a date is not shown.', { n: undated }) : tr('{n} issues without a date are not shown.', { n: undated })}</p>}
    </div>
  )
}

/** Timeline bars from start date to due date (or one week from the start date when there is no due date). */
export function TimelineLayout({ issues }: LayoutProps) {
  const { tr } = useI18n();

  const { items, unscheduled } = useMemo(() => timelineItems(issues), [issues])
  const ppd = PX_PER_DAY.months
  const { startDay, endDay } = useMemo(() => computeWindow(items, []), [items])
  const ticks = useMemo(() => headerTicks(startDay, endDay, ppd, 'months'), [startDay, endDay, ppd])
  const width = (endDay - startDay + 1) * ppd
  const todayX = (dayOf(new Date()) - startDay) * ppd
  if (issues.length === 0) return <EmptyState icon="search" title={tr('No issues match this view')} />
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        <div className="relative" style={{ width: width + 180 }} role="list" aria-label={tr('Timeline')}>
          <div className="relative h-8 border-b border-[var(--surface-3)] bg-[var(--surface-1)]" style={{ marginLeft: 180 }} aria-hidden>
            {ticks.map((t) => <span key={t.x} className="absolute top-2 text-caption text-[var(--text-secondary)]" style={{ left: t.x }}>{t.label}</span>)}
          </div>
          {items.map((it) => {
            const g = barGeometry(it, startDay, ppd)
            return (
              <div key={it.key} role="listitem" className="relative flex h-8 items-center border-b border-[var(--surface-3)] last:border-b-0">
                <Link href={`/issues/${it.key}`} className="w-[180px] shrink-0 truncate px-2 text-xs hover:underline" title={`${it.key} ${it.summary}`}>
                  <span className="font-medium">{it.key}</span> {it.summary}
                </Link>
                <span className={`absolute h-4 rounded ${g.open ? 'bg-[var(--brand-200)]' : 'bg-[var(--brand-500)]'}`} style={{ left: 180 + g.left, width: g.width }} title={`${it.start}${it.end ? ` to ${it.end}` : ''}`} />
              </div>
            )
          })}
          {todayX >= 0 && todayX <= width && <span className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--error)]" style={{ left: 180 + todayX }} aria-hidden />}
        </div>
      </div>
      {unscheduled.length > 0 && <p className="text-sm text-[var(--text-secondary)]">{unscheduled.length === 1 ? tr('{n} issue has no start or due date and is not shown.', { n: unscheduled.length }) : tr('{n} issues have no start or due date and are not shown.', { n: unscheduled.length })}</p>}
    </div>
  )
}

export function ViewLayout(props: LayoutProps) {
  switch (props.config.layout) {
    case 'table': return <TableLayout {...props} />
    case 'board': return <BoardLayout {...props} />
    case 'calendar': return <CalendarLayout {...props} />
    case 'timeline': return <TimelineLayout {...props} />
    default: return <ListLayout {...props} />
  }
}
