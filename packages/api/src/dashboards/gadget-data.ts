/**
 * Pure aggregations behind the dashboard gadget data endpoints. They take already permission-scoped issue rows,
 * so nothing here touches the database.
 */

export interface GadgetRow {
  id: number
  key: string
  summary: string
  status: string
  statusCategory: 'todo' | 'in_progress' | 'done' | 'cancelled'
  priority: string | null
  type: string
  assignee: string | null
  reporter: string | null
  resolution: string | null
  project: string
  projectKey: string
  labels: string[]
  components: string[]
  fixVersions: string[]
  createdAt: Date | null
  updatedAt: Date | null
  resolvedAt: Date | null
  dueDate: Date | null
  timeEstimate: number | null
  timeSpent: number | null
}

export type Metric = 'count' | 'estimate' | 'spent'
const DAY = 86_400_000
export const NONE = 'None'
export const UNASSIGNED = 'Unassigned'

const month = (d: Date | null) => (d ? d.toISOString().slice(0, 7) : NONE)

/** All values of a grouping field for one issue (multi-valued fields return several; empty ones return a placeholder). */
export function groupValues(row: GadgetRow, field: string): string[] {
  switch (field) {
    case 'status': return [row.status]
    case 'statusCategory': return [row.statusCategory === 'done' ? 'Done' : row.statusCategory === 'cancelled' ? 'Cancelled' : row.statusCategory === 'in_progress' ? 'In progress' : 'To do']
    case 'priority': return [row.priority ?? NONE]
    case 'type': case 'issuetype': return [row.type]
    case 'assignee': return [row.assignee ?? UNASSIGNED]
    case 'reporter': return [row.reporter ?? NONE]
    case 'resolution': return [row.resolution ?? 'Unresolved']
    case 'project': return [row.project]
    case 'component': return row.components.length ? row.components : [NONE]
    case 'labels': return row.labels.length ? row.labels : [NONE]
    case 'fixversion': return row.fixVersions.length ? row.fixVersions : [NONE]
    case 'createdMonth': return [month(row.createdAt)]
    case 'resolvedMonth': return [month(row.resolvedAt)]
    case 'dueMonth': return [month(row.dueDate)]
    default: return [NONE]
  }
}

const weight = (row: GadgetRow, metric: Metric) =>
  metric === 'estimate' ? (row.timeEstimate ?? 0) / 3600 : metric === 'spent' ? (row.timeSpent ?? 0) / 3600 : 1

const round = (n: number) => Math.round(n * 100) / 100

export interface Bucket { name: string; value: number }

/** Counts (or summed hours) per value of one field, biggest first, with a trailing "Other" bucket after `limit`. */
export function countBy(rows: GadgetRow[], field: string, opts: { metric?: Metric; limit?: number; sort?: 'count' | 'name' } = {}): { buckets: Bucket[]; total: number } {
  const metric = opts.metric ?? 'count'
  const map = new Map<string, number>()
  for (const r of rows) for (const v of groupValues(r, field)) map.set(v, (map.get(v) ?? 0) + weight(r, metric))
  let buckets = [...map.entries()].map(([name, value]) => ({ name, value: round(value) }))
  buckets.sort(opts.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.value - a.value || a.name.localeCompare(b.name))
  const limit = opts.limit ?? 0
  if (limit > 0 && buckets.length > limit) {
    const rest = buckets.slice(limit)
    buckets = [...buckets.slice(0, limit), { name: 'Other', value: round(rest.reduce((a, b) => a + b.value, 0)) }]
  }
  return { buckets, total: round(rows.reduce((a, r) => a + weight(r, metric), 0)) }
}

export interface CrossTab {
  columns: string[]
  rows: { name: string; cells: number[]; total: number }[]
  totals: number[]
  total: number
}

/** Two-dimensional statistics: rows are values of `field`, columns values of `field2`. */
export function crossTab(rows: GadgetRow[], field: string, field2: string, opts: { metric?: Metric; limit?: number } = {}): CrossTab {
  const metric = opts.metric ?? 'count'
  const limit = opts.limit ?? 20
  const cell = new Map<string, Map<string, number>>()
  const colTotals = new Map<string, number>()
  for (const r of rows) {
    const w = weight(r, metric)
    for (const a of groupValues(r, field)) {
      const m = cell.get(a) ?? new Map<string, number>()
      for (const b of groupValues(r, field2)) {
        m.set(b, (m.get(b) ?? 0) + w)
        colTotals.set(b, (colTotals.get(b) ?? 0) + w)
      }
      cell.set(a, m)
    }
  }
  const columns = [...colTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([n]) => n)
  const out = [...cell.entries()].map(([name, m]) => {
    const cells = columns.map((c) => round(m.get(c) ?? 0))
    return { name, cells, total: round([...m.values()].reduce((a, b) => a + b, 0)) }
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, limit)
  return {
    columns,
    rows: out,
    totals: columns.map((c) => round(colTotals.get(c) ?? 0)),
    total: round(rows.reduce((a, r) => a + weight(r, metric), 0)),
  }
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/** Issues per calendar day (UTC) for the last `days` days, zero filled. */
export function dailyCounts(dates: (Date | null)[], days: number, now = new Date()): { date: string; count: number }[] {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))
  const map = new Map<string, number>()
  for (let i = 0; i < days; i++) map.set(dayKey(new Date(start + i * DAY)), 0)
  for (const d of dates) {
    if (!d) continue
    const k = dayKey(d)
    if (map.has(k)) map.set(k, map.get(k)! + 1)
  }
  return [...map.entries()].map(([date, count]) => ({ date, count }))
}

/** Created and resolved per day or ISO-week/month bucket, with the running open-issue delta. */
export function createdResolved(rows: GadgetRow[], days: number, now = new Date()) {
  const created = dailyCounts(rows.map((r) => r.createdAt), days, now)
  const resolved = dailyCounts(rows.map((r) => r.resolvedAt), days, now)
  let cumulative = 0
  return created.map((c, i) => {
    cumulative += c.count - resolved[i].count
    return { date: c.date, created: c.count, resolved: resolved[i].count, net: cumulative }
  })
}

/** Number tile: matching issue count plus the change versus the previous window of `days` days (by creation). */
export function trend(rows: GadgetRow[], days: number, now = new Date()) {
  const t = now.getTime()
  const cur = rows.filter((r) => r.createdAt && r.createdAt.getTime() > t - days * DAY && r.createdAt.getTime() <= t).length
  const prev = rows.filter((r) => r.createdAt && r.createdAt.getTime() > t - 2 * days * DAY && r.createdAt.getTime() <= t - days * DAY).length
  return { current: cur, previous: prev, delta: cur - prev }
}

export interface ProgressRow { done: number; inProgress: number; todo: number; total: number; cancelled: number }

export function progressOf(rows: Pick<GadgetRow, 'statusCategory'>[]): ProgressRow {
  // Cancelled issues are reported separately and are not part of the total.
  const p = { done: 0, inProgress: 0, todo: 0, total: 0, cancelled: 0 }
  for (const r of rows) {
    if (r.statusCategory === 'cancelled') { p.cancelled++; continue }
    p.total++
    if (r.statusCategory === 'done') p.done++
    else if (r.statusCategory === 'in_progress') p.inProgress++
    else p.todo++
  }
  return p
}

/** Issues with a due date, grouped by day, for the due-date calendar. */
export function dueByDay(rows: GadgetRow[], from: Date, to: Date) {
  const map = new Map<string, { date: string; issues: { key: string; summary: string; overdue: boolean; done: boolean }[] }>()
  const now = Date.now()
  for (const r of rows) {
    if (!r.dueDate || r.dueDate < from || r.dueDate > to) continue
    const k = dayKey(r.dueDate)
    const e = map.get(k) ?? { date: k, issues: [] }
    e.issues.push({ key: r.key, summary: r.summary, done: r.statusCategory === 'done', overdue: r.statusCategory !== 'done' && r.statusCategory !== 'cancelled' && r.dueDate.getTime() < now })
    map.set(k, e)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** Cache key that ignores the cache-bypass parameter and the order of the remaining parameters. */
export function normaliseQuery(search: string): string {
  const p = new URLSearchParams(search)
  p.delete('nocache')
  p.delete('_')
  p.sort()
  return p.toString()
}
