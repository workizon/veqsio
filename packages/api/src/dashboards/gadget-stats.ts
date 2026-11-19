/**
 * Pure aggregation helpers for the Average Age and Resolution Time gadgets.
 * No DB access here so they can be unit tested in isolation.
 */

export type GadgetPeriod = 'daily' | 'weekly' | 'monthly'

export interface IssueTimes {
  createdAt: Date | string | null
  resolvedAt: Date | string | null
}

export interface AverageAgePoint {
  /** Period end date (YYYY-MM-DD, UTC) */
  date: string
  /** Average age in days of issues unresolved at period end (0 if none) */
  averageDays: number
  /** Number of issues open at period end */
  openCount: number
}

export interface ResolutionTimePoint {
  /** Period end date (YYYY-MM-DD, UTC) */
  date: string
  /** Average days from creation to resolution for issues resolved in period (0 if none) */
  averageDays: number
  resolvedCount: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const PERIOD_DAYS: Record<GadgetPeriod, number> = { daily: 1, weekly: 7, monthly: 30 }

export function parsePeriod(value: string | undefined): GadgetPeriod {
  return value === 'weekly' || value === 'monthly' ? value : 'daily'
}

function toMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Rolling windows ending at `now`, oldest first. */
export function buildPeriods(
  period: GadgetPeriod,
  count: number,
  now: Date,
): { start: number; end: number; label: string }[] {
  const step = PERIOD_DAYS[period] * DAY_MS
  const n = Math.max(1, Math.floor(count))
  const out: { start: number; end: number; label: string }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const end = now.getTime() - i * step
    out.push({ start: end - step, end, label: new Date(end).toISOString().slice(0, 10) })
  }
  return out
}

export function computeAverageAge(
  issues: IssueTimes[],
  opts: { period?: GadgetPeriod; count?: number; now?: Date } = {},
): AverageAgePoint[] {
  const periods = buildPeriods(opts.period ?? 'daily', opts.count ?? 30, opts.now ?? new Date())
  const parsed: { created: number; resolved: number | null }[] = []
  for (const i of issues) {
    const created = toMs(i.createdAt)
    if (created !== null) parsed.push({ created, resolved: toMs(i.resolvedAt) })
  }

  return periods.map(({ end, label }) => {
    let total = 0
    let open = 0
    for (const i of parsed) {
      if (i.created <= end && (i.resolved === null || i.resolved > end)) {
        total += end - i.created
        open++
      }
    }
    return { date: label, averageDays: open ? round2(total / open / DAY_MS) : 0, openCount: open }
  })
}

export function computeResolutionTime(
  issues: IssueTimes[],
  opts: { period?: GadgetPeriod; count?: number; now?: Date } = {},
): ResolutionTimePoint[] {
  const periods = buildPeriods(opts.period ?? 'daily', opts.count ?? 30, opts.now ?? new Date())
  const parsed: { created: number; resolved: number }[] = []
  for (const i of issues) {
    const created = toMs(i.createdAt)
    const resolved = toMs(i.resolvedAt)
    if (created !== null && resolved !== null) parsed.push({ created, resolved })
  }

  return periods.map(({ start, end, label }) => {
    let total = 0
    let n = 0
    for (const i of parsed) {
      if (i.resolved > start && i.resolved <= end) {
        total += Math.max(0, i.resolved - i.created)
        n++
      }
    }
    return { date: label, averageDays: n ? round2(total / n / DAY_MS) : 0, resolvedCount: n }
  })
}
