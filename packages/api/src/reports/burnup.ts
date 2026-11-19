/**
 * Pure series builders for the burnup, release burndown and version reports. They sit on the same inputs as
 * `agile.ts` (ReportIssue: status history already folded into `changes`) and add the one thing those charts need:
 * when an issue was IN the scope (sprint, version or epic), as a list of intervals derived from issue history.
 */
import {
  countUnestimated, doneAt, startOfDay,
  type Category, type CategoryOf, type ReportIssue,
} from './agile'

const DAY = 86_400_000
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** One stretch of time during which an issue belonged to the scope. `to: null` = still in. */
export interface ScopeInterval { from: number; to: number | null }

export interface ScopedIssue extends ReportIssue {
  /** When the issue was in scope. Empty = never (kept so a removed issue can still be listed). */
  intervals: ScopeInterval[]
}

/** A history entry reduced to "was in the scope before / is in it after". */
export interface MembershipEvent { at: number; before: boolean; after: boolean }

/**
 * Scope intervals from membership events (Sprint / fixVersions / parent history rows).
 * - no events: the issue is in scope since `fallbackFrom` when it is a member now, never otherwise;
 * - events: the initial state is the first event's `before` (in since `fallbackFrom`), every flip opens or closes
 *   an interval. Events at or after `dropFrom` are ignored (the bookkeeping rows written when a sprint is completed).
 */
export function intervalsFromEvents(
  events: MembershipEvent[],
  opts: { currentlyMember: boolean; fallbackFrom: number; dropFrom?: number },
): ScopeInterval[] {
  const ev = events
    .filter((e) => opts.dropFrom === undefined || e.at < opts.dropFrom)
    .sort((a, b) => a.at - b.at)
  if (ev.length === 0) return opts.currentlyMember ? [{ from: opts.fallbackFrom, to: null }] : []
  const out: ScopeInterval[] = []
  let open: number | null = ev[0].before ? opts.fallbackFrom : null
  for (const e of ev) {
    if (e.before === e.after) continue
    if (e.after && open === null) open = e.at
    else if (!e.after && open !== null) {
      out.push({ from: open, to: Math.max(open, e.at) })
      open = null
    }
  }
  if (open !== null) out.push({ from: open, to: null })
  return out
}

/** Whether the issue was in scope at time `t`. */
export const inScopeAt = (i: ScopedIssue, t: number): boolean =>
  i.intervals.some((iv) => iv.from <= t && (iv.to === null || iv.to > t))

/* ---------------- Scope changes ---------------- */

export interface ScopeChange { at: string; key: string; kind: 'added' | 'removed'; size: number }

/** Issues that joined (or left) the scope after `since`, oldest first. Joining at or before `since` is the initial scope. */
export function scopeChanges(issues: ScopedIssue[], since: number, until = Infinity): ScopeChange[] {
  const out: Array<ScopeChange & { t: number }> = []
  for (const i of issues) {
    for (const iv of i.intervals) {
      // Opening after `since` is an addition (a re-join counts too); closing after `since` is a removal.
      if (iv.from > since && iv.from <= until) out.push({ t: iv.from, at: new Date(iv.from).toISOString(), key: i.key, kind: 'added', size: i.size })
      if (iv.to !== null && iv.to > since && iv.to <= until) out.push({ t: iv.to, at: new Date(iv.to).toISOString(), key: i.key, kind: 'removed', size: i.size })
    }
  }
  return out.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key)).map(({ t: _t, ...rest }) => rest)
}

/* ---------------- Burnup ---------------- */

export interface BurnupPoint {
  date: string
  /** Total size of the issues in scope at the end of the day (NaN for days after `now`). */
  scope: number
  /** Size of in-scope issues that are done at the end of the day. */
  completed: number
}

export interface BurnupResult {
  /** Scope at the start of the window (what was committed). */
  initialScope: number
  scope: number
  completed: number
  unestimated: number
  points: BurnupPoint[]
  scopeChanges: ScopeChange[]
}

/** Largest number of daily points a report returns; older days are cut so a years-old version stays readable. */
export const MAX_DAYS = 366

export function burnup(args: { start: number; end: number; now: number; issues: ScopedIssue[]; cat: CategoryOf }): BurnupResult {
  const { start, end, now, issues, cat } = args
  const lastDay = startOfDay(Math.max(end, start))
  const firstDay = Math.max(startOfDay(start), lastDay - MAX_DAYS * DAY)
  const days = Math.max(1, Math.round((lastDay - firstDay) / DAY))
  const points: BurnupPoint[] = []
  let scope = 0
  let completed = 0
  for (let d = 0; d <= days; d++) {
    const dayStart = firstDay + d * DAY
    const date = isoDay(dayStart)
    if (dayStart > now) { points.push({ date, scope: NaN, completed: NaN }); continue }
    const at = Math.min(dayStart + DAY - 1, now)
    scope = 0
    completed = 0
    for (const i of issues) {
      if (!inScopeAt(i, at)) continue
      scope += i.size
      if (doneAt(i, cat, at) !== null) completed += i.size
    }
    points.push({ date, scope, completed })
  }
  const initialScope = issues.reduce((a, i) => a + (inScopeAt(i, start) ? i.size : 0), 0)
  const inScopeNow = issues.filter((i) => inScopeAt(i, Math.min(now, end + DAY)))
  return {
    initialScope, scope, completed,
    unestimated: countUnestimated(inScopeNow),
    points,
    scopeChanges: scopeChanges(issues, start, now),
  }
}

/* ---------------- Velocity, projection ---------------- */

/** Size completed per day over the last `lookbackDays` (issues in scope and done now, finished inside the window). */
export function recentVelocityPerDay(issues: ScopedIssue[], cat: CategoryOf, now: number, lookbackDays: number): number {
  const from = now - lookbackDays * DAY
  let sum = 0
  for (const i of issues) {
    if (!inScopeAt(i, now)) continue
    const d = doneAt(i, cat, now)
    if (d !== null && d > from && d <= now) sum += i.size
  }
  return sum / lookbackDays
}

/** When the remaining work is finished at a steady pace, or null when there is no pace (or it is beyond two years). */
export function projectCompletion(remaining: number, velocityPerDay: number, now: number, maxDays = 730): number | null {
  if (remaining <= 0) return now
  if (!(velocityPerDay > 0)) return null
  const days = remaining / velocityPerDay
  if (days > maxDays) return null
  return now + Math.ceil(days) * DAY
}

/* ---------------- Release burndown ---------------- */

export interface ReleaseBurndownPoint {
  date: string
  scope: number
  completed: number
  remaining: number
  /** Straight line from the remaining work at the start to zero on the release date (null without a release date). */
  ideal: number | null
  /** Where the recent velocity leads from today on (null before today). */
  projected: number | null
}

export interface ReleaseBurndown {
  unit?: string
  points: ReleaseBurndownPoint[]
  remaining: number
  completed: number
  scope: number
  unestimated: number
  velocityPerDay: number
  lookbackDays: number
  releaseDate: string | null
  projectedDate: string | null
  /** null when there is no release date or no velocity to judge by. */
  onTrack: boolean | null
  daysLate: number | null
}

export function releaseBurndown(args: {
  start: number; releaseDate: number | null; now: number; issues: ScopedIssue[]; cat: CategoryOf; lookbackDays?: number
}): ReleaseBurndown {
  const { start, releaseDate, now, issues, cat } = args
  const lookbackDays = Math.min(Math.max(Math.round(args.lookbackDays ?? 14), 1), 180)
  const releaseEnd = releaseDate === null ? null : startOfDay(releaseDate) + DAY - 1
  const velocityPerDay = recentVelocityPerDay(issues, cat, now, lookbackDays)

  // Current state decides the projection, then the chart window is stretched to show it.
  const inScopeNow = issues.filter((i) => inScopeAt(i, now))
  const scopeNow = inScopeNow.reduce((a, i) => a + i.size, 0)
  const completedNow = inScopeNow.reduce((a, i) => a + (doneAt(i, cat, now) !== null ? i.size : 0), 0)
  const remainingNow = scopeNow - completedNow
  const projectedAt = projectCompletion(remainingNow, velocityPerDay, now)

  const lastWanted = Math.max(startOfDay(now), releaseDate === null ? 0 : startOfDay(releaseDate), projectedAt === null ? 0 : startOfDay(projectedAt))
  const base = burnup({ start, end: lastWanted, now, issues, cat })
  const firstDate = base.points[0]?.date
  const firstDay = firstDate ? Date.parse(firstDate) : startOfDay(start)
  const todayIdx = Math.round((startOfDay(now) - firstDay) / DAY)
  const releaseIdx = releaseEnd === null ? null : Math.round((startOfDay(releaseEnd) - firstDay) / DAY)
  const r0 = base.points[0] && Number.isFinite(base.points[0].scope) ? base.points[0].scope - base.points[0].completed : 0

  const points: ReleaseBurndownPoint[] = base.points.map((p, idx) => {
    const future = !Number.isFinite(p.scope)
    const remaining = future ? NaN : p.scope - p.completed
    let ideal: number | null = null
    if (releaseIdx !== null) ideal = releaseIdx <= 0 ? 0 : Math.max(0, r0 - (r0 * Math.min(idx, releaseIdx)) / releaseIdx)
    let projected: number | null = null
    if (idx === todayIdx) projected = remainingNow
    else if (idx > todayIdx && velocityPerDay > 0) projected = Math.max(0, round2(remainingNow - velocityPerDay * (idx - todayIdx)))
    return { date: p.date, scope: p.scope, completed: p.completed, remaining, ideal, projected }
  })

  const daysLate = projectedAt === null || releaseEnd === null ? null : Math.max(0, Math.ceil((projectedAt - releaseEnd) / DAY))
  return {
    points,
    remaining: remainingNow, completed: completedNow, scope: scopeNow,
    unestimated: countUnestimated(inScopeNow),
    velocityPerDay: round2(velocityPerDay), lookbackDays,
    releaseDate: releaseEnd === null ? null : isoDay(releaseEnd),
    projectedDate: projectedAt === null ? null : isoDay(projectedAt),
    onTrack: remainingNow <= 0 ? true : projectedAt === null || releaseEnd === null ? null : projectedAt <= releaseEnd,
    daysLate,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/* ---------------- Version report ---------------- */

export interface VersionIssueRow {
  key: string
  summary: string
  status: string
  category: Category
  type: string | null
  assignee: string | null
  priority: string | null
  size: number
  estimated: boolean
  flagged: boolean
}

export interface StatusGroup { status: string; category: Category; issues: VersionIssueRow[] }

export interface VersionSummary {
  /** Issue counts by status category, whatever the unit. */
  issues: { done: number; inProgress: number; todo: number; total: number }
  /** Size in the chosen unit. */
  completed: number
  remaining: number
  total: number
  unestimated: number
  flagged: number
  groups: StatusGroup[]
}

const CATEGORY_ORDER: Record<Category, number> = { todo: 0, in_progress: 1, done: 2, cancelled: 3 }

/** Counts, completed vs remaining and the issue table grouped by status (to do first, done last). */
export function summarizeVersion(rows: VersionIssueRow[]): VersionSummary {
  const groups = new Map<string, StatusGroup>()
  const c = { done: 0, inProgress: 0, todo: 0, total: rows.length }
  let completed = 0
  let remaining = 0
  for (const r of rows) {
    if (r.category === 'done') { c.done++; completed += r.size }
    else { remaining += r.size; if (r.category === 'in_progress') c.inProgress++; else c.todo++ }
    const g = groups.get(r.status)
    if (g) g.issues.push(r)
    else groups.set(r.status, { status: r.status, category: r.category, issues: [r] })
  }
  const ordered = [...groups.values()].sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.status.localeCompare(b.status))
  for (const g of ordered) g.issues.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
  return {
    issues: c, completed, remaining, total: completed + remaining,
    unestimated: rows.filter((r) => !r.estimated).length,
    flagged: rows.filter((r) => r.flagged).length,
    groups: ordered,
  }
}
