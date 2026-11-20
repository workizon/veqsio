/** Pure helpers that turn the burnup / release burndown / version report API payloads into chart rows and text. */
import { trNow } from './tr'

export type ReportUnit = 'issues' | 'hours' | 'points'

export interface BurnupPoint { date: string; scope: number | null; completed: number | null }
export interface ReleasePoint extends BurnupPoint { remaining: number | null; ideal: number | null; projected: number | null }

/** Rows for a chart: days after today have null values and are dropped from the line (recharts skips missing keys). */
export function burnupRows(points: BurnupPoint[]): Array<Record<string, string | number>> {
  return points.map((p) => {
    const row: Record<string, string | number> = { date: p.date }
    if (typeof p.scope === 'number' && Number.isFinite(p.scope)) row.scope = p.scope
    if (typeof p.completed === 'number' && Number.isFinite(p.completed)) row.completed = p.completed
    return row
  })
}

export function releaseRows(points: ReleasePoint[]): Array<Record<string, string | number>> {
  return points.map((p) => {
    const row: Record<string, string | number> = { date: p.date }
    for (const k of ['remaining', 'ideal', 'projected', 'scope', 'completed'] as const) {
      const v = p[k]
      if (typeof v === 'number' && Number.isFinite(v)) row[k] = v
    }
    return row
  })
}

/** 5 -> "5 points", 1 -> "1 issue", 2.5 -> "2.5 h". */
export function formatQty(n: number, unit: ReportUnit): string {
  const v = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
  if (unit === 'hours') return `${v} h`
  if (unit === 'points') return `${v} ${n === 1 ? 'point' : 'points'}`
  return `${v} ${n === 1 ? 'issue' : 'issues'}`
}

export const unitNoun = (unit: ReportUnit) => (unit === 'points' ? 'story points' : unit === 'hours' ? 'hours' : 'issues')

/** Pace line: "0.5 points per day over the last 14 days". */
export function formatVelocity(perDay: number, unit: ReportUnit, lookbackDays: number): string {
  if (!(perDay > 0)) return trNow('No work completed in the last {days} days', { days: lookbackDays })
  return trNow('{qty} per day over the last {days} days', { qty: formatQty(perDay, unit), days: lookbackDays })
}

export interface Projection { projectedDate: string | null; releaseDate: string | null; onTrack: boolean | null; daysLate: number | null }

/** Headline and tone for the projected release date. */
export function projectionSummary(p: Projection | null | undefined): { text: string; tone: 'good' | 'bad' | 'neutral' } {
  if (!p) return { text: 'Released', tone: 'neutral' }
  if (p.projectedDate === null) return { text: 'No projection: nothing was completed recently', tone: 'neutral' }
  if (p.releaseDate === null) return { text: `Projected finish ${p.projectedDate}`, tone: 'neutral' }
  if (p.onTrack) return { text: `On track: projected ${p.projectedDate}, release ${p.releaseDate}`, tone: 'good' }
  const late = p.daysLate ?? 0
  return { text: `${late} ${late === 1 ? 'day' : 'days'} late: projected ${p.projectedDate}, release ${p.releaseDate}`, tone: 'bad' }
}

/** Share of the total that is done, 0-100, rounded. */
export const percentDone = (completed: number, total: number) => (total > 0 ? Math.round((completed / total) * 100) : 0)

/** Net scope change of a sprint or version: "+5 added, -1 removed". */
export function scopeChangeSummary(changes: Array<{ kind: 'added' | 'removed'; size: number }>, unit: ReportUnit): string {
  const added = changes.filter((c) => c.kind === 'added')
  const removed = changes.filter((c) => c.kind === 'removed')
  if (!changes.length) return trNow('No scope changes')
  const sum = (l: typeof changes) => l.reduce((a, c) => a + c.size, 0)
  return trNow('+{added} added ({addedCount}), -{removed} removed ({removedCount})', { added: formatQty(sum(added), unit), addedCount: added.length, removed: formatQty(sum(removed), unit), removedCount: removed.length })
}
