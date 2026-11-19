/** Pure aggregation helpers for the service desk report (unit-testable, no DB). */

export interface ReportRow {
  createdAt: Date
  resolvedAt: Date | null
  assigneeId: number | null
  assigneeName: string | null
  csatRating: number | null
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/** Daily created/resolved counts for the last `days` days (UTC, inclusive of today). */
export function dailySeries(rows: ReportRow[], days: number, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)))
  const map = new Map<string, { date: string; created: number; resolved: number }>()
  for (let i = 0; i < days; i++) {
    const k = dayKey(new Date(start.getTime() + i * 86_400_000))
    map.set(k, { date: k, created: 0, resolved: 0 })
  }
  for (const r of rows) {
    const c = map.get(dayKey(r.createdAt)); if (c) c.created++
    if (r.resolvedAt) { const e = map.get(dayKey(r.resolvedAt)); if (e) e.resolved++ }
  }
  return [...map.values()]
}

/** Open / resolved-in-period workload per assignee; unassigned requests are grouped under id null. */
export function workloadByAgent(rows: ReportRow[], since: Date) {
  const map = new Map<number | null, { userId: number | null; name: string; open: number; resolved: number }>()
  for (const r of rows) {
    const e = map.get(r.assigneeId) ?? { userId: r.assigneeId, name: r.assigneeName ?? 'Unassigned', open: 0, resolved: 0 }
    if (!r.resolvedAt) e.open++
    else if (r.resolvedAt >= since) e.resolved++
    map.set(r.assigneeId, e)
  }
  return [...map.values()].filter((e) => e.open || e.resolved).sort((a, b) => b.open - a.open || b.resolved - a.resolved)
}

/** Counts of ratings 1..5. */
export function csatDistribution(rows: ReportRow[]) {
  const dist = [0, 0, 0, 0, 0]
  for (const r of rows) if (r.csatRating && r.csatRating >= 1 && r.csatRating <= 5) dist[r.csatRating - 1]++
  return dist.map((count, i) => ({ rating: i + 1, count }))
}

/* ---------------------------- CSAT reporting ---------------------------- */

export interface CsatRow {
  rating: number | null
  ratedAt: Date | null
  /** Resolved requests are the ones a survey can reach; used for the response rate. */
  resolved: boolean
  groupKey: string | null
  groupName: string | null
}

export interface CsatSummary { responses: number; average: number | null; satisfiedPct: number | null; responseRatePct: number | null }

/** Average, share of 4-5 ratings ("satisfied") and the share of resolved requests that were rated. */
export function csatSummary(rows: CsatRow[]): CsatSummary {
  const rated = rows.filter((r) => r.rating && r.rating >= 1 && r.rating <= 5)
  const resolved = rows.filter((r) => r.resolved).length
  return {
    responses: rated.length,
    average: rated.length ? rated.reduce((a, r) => a + r.rating!, 0) / rated.length : null,
    satisfiedPct: rated.length ? (rated.filter((r) => r.rating! >= 4).length / rated.length) * 100 : null,
    responseRatePct: resolved ? Math.min(100, (rated.length / resolved) * 100) : null,
  }
}

/** Monday (UTC) of the week of a date, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10)
}

/** Weekly average rating and count, oldest first, for the weeks between `from` and `to` (empty weeks included). */
export function csatTrend(rows: CsatRow[], from: Date, to: Date): Array<{ week: string; responses: number; average: number | null }> {
  const weeks = new Map<string, { sum: number; n: number }>()
  for (let t = Date.parse(weekStart(from)); t <= Date.parse(weekStart(to)); t += 7 * 86_400_000) weeks.set(new Date(t).toISOString().slice(0, 10), { sum: 0, n: 0 })
  for (const r of rows) {
    if (!r.rating || !r.ratedAt) continue
    const w = weeks.get(weekStart(r.ratedAt))
    if (w) { w.sum += r.rating; w.n++ }
  }
  return [...weeks.entries()].map(([week, v]) => ({ week, responses: v.n, average: v.n ? v.sum / v.n : null }))
}

/** Summary per group (agent, request type, ...); rows without a group are collected under "Unassigned". Best average first. */
export function csatByGroup(rows: CsatRow[]): Array<CsatSummary & { key: string | null; name: string }> {
  const groups = new Map<string | null, CsatRow[]>()
  for (const r of rows) groups.set(r.groupKey, [...(groups.get(r.groupKey) ?? []), r])
  return [...groups.entries()]
    .map(([key, list]) => ({ key, name: list.find((r) => r.groupName)?.groupName ?? 'Unassigned', ...csatSummary(list) }))
    .filter((g) => g.responses > 0)
    .sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || b.responses - a.responses)
}

/** A poor rating (1 or 2) that nobody has handled yet. */
export const needsFollowUp = (rating: number | null, handledAt: Date | null): boolean => !!rating && rating <= 2 && !handledAt

/* ----------------------- knowledge base and automation insights ----------------------- */

export interface KbArticleRow { id: number; title: string; published: boolean; views: number; helpful: number; notHelpful: number; updatedAt: Date }

/** Per article: helpful share among the votes (null without votes). Most viewed first. */
export function kbArticleStats(rows: KbArticleRow[]) {
  return rows
    .map((a) => ({ ...a, votes: a.helpful + a.notHelpful, helpfulPct: a.helpful + a.notHelpful > 0 ? (a.helpful / (a.helpful + a.notHelpful)) * 100 : null }))
    .sort((a, b) => b.views - a.views || a.title.localeCompare(b.title))
}

/** Normalises a search term for grouping: trimmed, lower case, single spaces. */
export const normalizeTerm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)

export interface SearchRow { term: string; results: number }

/** Searches grouped by term: how often, and how many results they usually get. `gaps` = terms that never found anything. */
export function searchStats(rows: SearchRow[]) {
  const map = new Map<string, { term: string; searches: number; withResults: number }>()
  for (const r of rows) {
    const k = normalizeTerm(r.term)
    if (!k) continue
    const e = map.get(k) ?? { term: k, searches: 0, withResults: 0 }
    e.searches++
    if (r.results > 0) e.withResults++
    map.set(k, e)
  }
  const all = [...map.values()].sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term))
  return { top: all.slice(0, 20), gaps: all.filter((s) => s.withResults === 0).slice(0, 20) }
}

export interface RunRow { ruleId: number; outcome: string | null; ranAt: Date }

/** Runs per rule in a period, with failures (outcome starting with "failed") and the last run. */
export function automationRunStats(rows: RunRow[]) {
  const map = new Map<number, { ruleId: number; runs: number; failures: number; lastRunAt: Date | null; lastFailure: string | null }>()
  for (const r of rows) {
    const e = map.get(r.ruleId) ?? { ruleId: r.ruleId, runs: 0, failures: 0, lastRunAt: null, lastFailure: null }
    e.runs++
    const failed = !!r.outcome?.startsWith('failed')
    if (failed) { e.failures++; if (!e.lastFailure || (e.lastRunAt && r.ranAt >= e.lastRunAt)) e.lastFailure = r.outcome }
    if (!e.lastRunAt || r.ranAt > e.lastRunAt) e.lastRunAt = r.ranAt
    map.set(r.ruleId, e)
  }
  return [...map.values()]
}
