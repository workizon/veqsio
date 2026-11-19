/**
 * Pure calculations for agile reports. All inputs are plain data so the logic is unit-testable
 * without a database.
 */

/** 'cancelled' is only used for the progress of epics/roadmap items: cancelled work is out of scope, not done. Burndown, velocity and flow reports drop cancelled issues before they get here. */
export type Category = 'todo' | 'in_progress' | 'done' | 'cancelled'

export interface StatusChange { at: number; to: string }

export interface ReportIssue {
  id: number
  key: string
  summary: string
  createdAt: number
  /** Initial status name at creation. */
  initialStatus: string
  /** Chronological status transitions. */
  changes: StatusChange[]
  /** Size of the work in the chosen unit (1 for issue count, hours for estimates). */
  size: number
  /** False when the chosen unit has no value for this issue (e.g. no story points). Defaults to true. */
  estimated?: boolean
  /** Currently flagged as an impediment. */
  flagged?: boolean
}

export type ReportUnit = 'issues' | 'hours' | 'points'

/** Size of an issue in the chosen unit. Unestimated issues (null points/hours) count as 0. */
export function sizeFor(unit: ReportUnit, i: { timeEstimate: number | null; storyPoints: string | number | null }): { size: number; estimated: boolean } {
  if (unit === 'hours') return { size: (i.timeEstimate ?? 0) / 3600, estimated: i.timeEstimate !== null }
  if (unit === 'points') {
    const n = i.storyPoints === null || i.storyPoints === undefined ? null : Number(i.storyPoints)
    return { size: n !== null && Number.isFinite(n) ? n : 0, estimated: n !== null && Number.isFinite(n) }
  }
  return { size: 1, estimated: true }
}

/** Number of issues without a value in the chosen unit. */
export const countUnestimated = (issues: Array<{ estimated?: boolean }>) => issues.filter((i) => i.estimated === false).length

export type CategoryOf = (status: string) => Category

const DAY = 86_400_000
export const startOfDay = (t: number) => Math.floor(t / DAY) * DAY

/** Status name of an issue at time `t` (null before it existed). */
export function statusAt(i: ReportIssue, t: number): string | null {
  if (t < i.createdAt) return null
  let s = i.initialStatus
  for (const c of i.changes) {
    if (c.at <= t) s = c.to
    else break
  }
  return s
}

/** Time the issue most recently entered a done status (and stayed), or null if not done at `asOf`. */
export function doneAt(i: ReportIssue, cat: CategoryOf, asOf = Infinity): number | null {
  let result: number | null = cat(i.initialStatus) === 'done' ? i.createdAt : null
  for (const c of i.changes) {
    if (c.at > asOf) break
    result = cat(c.to) === 'done' ? (result ?? c.at) : null
  }
  return result
}

/** First time the issue entered in-progress (or null). */
export function startedAt(i: ReportIssue, cat: CategoryOf): number | null {
  if (cat(i.initialStatus) === 'in_progress') return i.createdAt
  for (const c of i.changes) if (cat(c.to) === 'in_progress') return c.at
  return null
}

/* ---------------- Burndown ---------------- */

export interface BurndownPoint { date: string; remaining: number; ideal: number }

export function burndown(args: {
  start: number; end: number; now: number; issues: ReportIssue[]; cat: CategoryOf
}): { total: number; unestimated: number; points: BurndownPoint[] } {
  const { start, end, now, issues, cat } = args
  const total = issues.reduce((a, i) => a + i.size, 0)
  const firstDay = startOfDay(start)
  const lastDay = startOfDay(end)
  const days = Math.max(1, Math.round((lastDay - firstDay) / DAY))
  const points: BurndownPoint[] = []
  for (let d = 0; d <= days; d++) {
    const dayEnd = firstDay + d * DAY + DAY - 1
    const ideal = Math.max(0, total - (total * d) / days)
    if (dayEnd - DAY + 1 > now) {
      points.push({ date: new Date(firstDay + d * DAY).toISOString().slice(0, 10), remaining: NaN, ideal })
      continue
    }
    const at = Math.min(dayEnd, now)
    let remaining = 0
    for (const i of issues) {
      const done = doneAt(i, cat, at)
      if (done === null || done > at) remaining += i.size
    }
    points.push({ date: new Date(firstDay + d * DAY).toISOString().slice(0, 10), remaining, ideal })
  }
  return { total, unestimated: countUnestimated(issues), points }
}

/* ---------------- Sprint report / velocity ---------------- */

export interface SprintSummary {
  committed: number
  completed: number
  incomplete: number
  completedIssues: string[]
  incompleteIssues: string[]
  /** Issues in the sprint without an estimate in the chosen unit. */
  unestimated: number
  /** Issues of the sprint that are flagged as impediments right now. */
  flaggedIssues: string[]
}

export function sprintSummary(issues: ReportIssue[], cat: CategoryOf, asOf: number): SprintSummary {
  const completedIssues: string[] = []
  const incompleteIssues: string[] = []
  let completed = 0
  let incomplete = 0
  for (const i of issues) {
    const d = doneAt(i, cat, asOf)
    if (d !== null) { completed += i.size; completedIssues.push(i.key) }
    else { incomplete += i.size; incompleteIssues.push(i.key) }
  }
  return {
    committed: completed + incomplete, completed, incomplete, completedIssues, incompleteIssues, unestimated: countUnestimated(issues),
    flaggedIssues: issues.filter((i) => i.flagged).map((i) => i.key),
  }
}

/* ---------------- Cumulative flow ---------------- */

export interface CfdPoint { date: string; todo: number; in_progress: number; done: number }

export function cumulativeFlow(args: { from: number; to: number; issues: ReportIssue[]; cat: CategoryOf }): CfdPoint[] {
  const { from, to, issues, cat } = args
  const out: CfdPoint[] = []
  for (let d = startOfDay(from); d <= startOfDay(to); d += DAY) {
    const at = d + DAY - 1
    const p: CfdPoint = { date: new Date(d).toISOString().slice(0, 10), todo: 0, in_progress: 0, done: 0 }
    for (const i of issues) {
      const s = statusAt(i, at)
      if (s !== null) { const c = cat(s); if (c !== 'cancelled') p[c] += 1 }   // cancelled work is not part of the flow
    }
    out.push(p)
  }
  return out
}

/* ---------------- Control chart ---------------- */

export interface ControlPoint { key: string; doneAt: string; cycleDays: number; leadDays: number }

export function controlChart(args: { issues: ReportIssue[]; cat: CategoryOf; from: number; to: number }): {
  points: ControlPoint[]; averageCycleDays: number | null; medianCycleDays: number | null; p85CycleDays: number | null
} {
  const points: ControlPoint[] = []
  for (const i of args.issues) {
    const done = doneAt(i, args.cat)
    if (done === null || done < args.from || done > args.to) continue
    const started = startedAt(i, args.cat) ?? i.createdAt
    points.push({
      key: i.key,
      doneAt: new Date(done).toISOString(),
      cycleDays: Math.max(0, (done - started) / DAY),
      leadDays: Math.max(0, (done - i.createdAt) / DAY),
    })
  }
  points.sort((a, b) => a.doneAt.localeCompare(b.doneAt))
  const sorted = points.map((p) => p.cycleDays).sort((a, b) => a - b)
  const pct = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null)
  return {
    points,
    averageCycleDays: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    medianCycleDays: pct(0.5),
    p85CycleDays: pct(0.85),
  }
}

/* ---------------- Epic report ---------------- */

export interface EpicProgress { key: string; summary: string; total: number; done: number; inProgress: number; todo: number; percentDone: number; unestimated: number }

export function epicProgress(epics: Array<{ key: string; summary: string }>, children: Array<{ epicKey: string; category: Category; size: number; estimated?: boolean }>): EpicProgress[] {
  return epics.map((e) => {
    const mine = children.filter((c) => c.epicKey === e.key && c.category !== 'cancelled')
    const sum = (cat: Category) => mine.filter((c) => c.category === cat).reduce((a, c) => a + c.size, 0)
    const total = mine.reduce((a, c) => a + c.size, 0)
    return {
      key: e.key, summary: e.summary, total, done: sum('done'), inProgress: sum('in_progress'), todo: sum('todo'),
      percentDone: total ? Math.round((sum('done') / total) * 100) : 0,
      unestimated: countUnestimated(mine),
    }
  })
}
