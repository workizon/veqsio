/** Pure helpers for initiatives and milestones (labels, timeline strip, progress text). */
import { DAY, dayOf } from './roadmap-layout'

export type InitiativeStatus = 'planned' | 'active' | 'completed' | 'cancelled'

export const INITIATIVE_STATUS_OPTIONS: Array<{ value: InitiativeStatus; label: string; color: string }> = [
  { value: 'planned', label: 'Planned', color: '#667085' },
  { value: 'active', label: 'Active', color: '#2D54D8' },
  { value: 'completed', label: 'Completed', color: '#16A06A' },
  { value: 'cancelled', label: 'Cancelled', color: '#B42318' },
]

export function initiativeStatusBadge(status: string): { label: string; color: string } {
  const o = INITIATIVE_STATUS_OPTIONS.find((x) => x.value === status)
  return o ? { label: o.label, color: o.color } : { label: status, color: '#667085' }
}

export interface ProgressLike { total: number; done: number; percentDone: number; cancelled?: number }

/** "3 of 7 done (43%), 1 cancelled" ; "No work yet" when nothing counts. */
export function progressText(p: ProgressLike): string {
  if (p.total === 0) return p.cancelled ? `No open work (${p.cancelled} cancelled)` : 'No work yet'
  return `${p.done} of ${p.total} done (${p.percentDone}%)${p.cancelled ? `, ${p.cancelled} cancelled` : ''}`
}

export type TimelineState = 'no-dates' | 'not-started' | 'in-progress' | 'overdue' | 'finished'

export interface TimelineStrip {
  state: TimelineState
  /** 0..100 position of "today" along start..target (clamped); null without both dates */
  todayPct: number | null
  /** 0..100 filled part for the elapsed time (clamped) */
  elapsedPct: number
  /** days from today to the target date (negative when past); null without a target */
  daysLeft: number | null
  label: string
}

/**
 * The strip under an initiative's dates: where today lies between start and target.
 * `status` completed/cancelled ends the timeline ("finished") even when the target is in the past.
 */
export function timelineStrip(start: string | null, target: string | null, status: string, today: Date = new Date()): TimelineStrip {
  const t = dayOf(today)
  const daysLeft = target ? dayOf(target) - t : null
  if (status === 'completed' || status === 'cancelled') {
    return { state: 'finished', todayPct: null, elapsedPct: 100, daysLeft, label: status === 'completed' ? 'Completed' : 'Cancelled' }
  }
  if (!start || !target) {
    return {
      state: 'no-dates', todayPct: null, elapsedPct: 0, daysLeft,
      label: !target ? 'No dates set' : daysLeft! < 0 ? `${-daysLeft!} day${daysLeft === -1 ? '' : 's'} past the target` : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`,
    }
  }
  const s = dayOf(start)
  const e = dayOf(target)
  const span = Math.max(e - s, 1)
  const pct = Math.min(100, Math.max(0, Math.round(((t - s) / span) * 100)))
  if (t < s) return { state: 'not-started', todayPct: 0, elapsedPct: 0, daysLeft, label: `Starts in ${s - t} day${s - t === 1 ? '' : 's'}` }
  if (t > e) return { state: 'overdue', todayPct: 100, elapsedPct: 100, daysLeft, label: `${t - e} day${t - e === 1 ? '' : 's'} past the target` }
  return { state: 'in-progress', todayPct: pct, elapsedPct: pct, daysLeft, label: daysLeft === 0 ? 'Target is today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` }
}

/** Date range text such as "1 Jan 2026 – 31 Dec 2026"; open ends are shown as "no start" / "no target". */
export function dateRangeText(start: string | null, target: string | null): string {
  const fmt = (d: string) => new Date(Date.parse(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  if (!start && !target) return 'No dates'
  return `${start ? fmt(start) : 'no start'} – ${target ? fmt(target) : 'no target'}`
}

export interface MilestoneMarkerInput { id: number; name: string; targetDate: string; state: string; percent: number }

/** Horizontal pixel position and accessible text of a milestone marker on the roadmap. */
export function milestoneMarker(m: MilestoneMarkerInput, startDay: number, ppd: number, todayMs: number = Date.now()): { x: number; label: string; color: string; overdue: boolean } {
  const reached = m.state === 'reached'
  const overdue = !reached && dayOf(m.targetDate) < Math.floor(todayMs / DAY)
  return {
    x: (dayOf(m.targetDate) - startDay) * ppd,
    label: `${m.name}, ${reached ? 'reached' : overdue ? 'overdue' : 'open'}, ${m.percent}% done, due ${m.targetDate}`,
    color: reached ? '#16A06A' : overdue ? '#C9372C' : '#2D54D8',
    overdue,
  }
}

/** Days the roadmap window must cover so every dated milestone is visible. */
export function milestoneDays(ms: ReadonlyArray<{ targetDate: string | null }>): number[] {
  return ms.filter((m) => m.targetDate).map((m) => dayOf(m.targetDate!))
}
