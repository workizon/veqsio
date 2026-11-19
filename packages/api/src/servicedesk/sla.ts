/**
 * SLA engine for Veqsio Service Desk.
 *
 * Elapsed time is derived from immutable facts (issue creation, comments, status history),
 * so no hooks are required in the workflow engine and results are always consistent.
 */

export interface BusinessHours {
  /** Offset from UTC in minutes for the desk's timezone (e.g. 180 for UTC+3). */
  utcOffsetMinutes?: number;
  /** Working windows per weekday, "HH:MM" strings. Keys: sun,mon,tue,wed,thu,fri,sat */
  days: Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', Array<[string, string]>>>;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  utcOffsetMinutes: 0,
  days: {
    mon: [['09:00', '18:00']],
    tue: [['09:00', '18:00']],
    wed: [['09:00', '18:00']],
    thu: [['09:00', '18:00']],
    fri: [['09:00', '18:00']],
  },
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_MS = 86_400_000;

function hmToMs(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return ((h || 0) * 60 + (m || 0)) * 60_000;
}

/** Milliseconds of working time between `from` and `to` according to `hours`. */
export function businessMillisBetween(from: number, to: number, hours: BusinessHours): number {
  if (to <= from) return 0;
  const offset = (hours.utcOffsetMinutes ?? 0) * 60_000;
  // Work in "local" time: shift so that UTC arithmetic yields local wall clock.
  const a = from + offset;
  const b = to + offset;
  let total = 0;
  let dayStart = Math.floor(a / DAY_MS) * DAY_MS;
  let guard = 0;
  while (dayStart < b && guard++ < 3660) {
    const key = DAY_KEYS[new Date(dayStart).getUTCDay()];
    for (const [s, e] of hours.days[key] ?? []) {
      const ws = dayStart + hmToMs(s);
      const we = dayStart + hmToMs(e);
      const lo = Math.max(ws, a);
      const hi = Math.min(we, b);
      if (hi > lo) total += hi - lo;
    }
    dayStart += DAY_MS;
  }
  return total;
}

export interface Interval { start: number; end: number }

/** Merge and clip intervals to [lo, hi]. */
export function normalizeIntervals(intervals: Interval[], lo: number, hi: number): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, lo), end: Math.min(i.end, hi) }))
    .filter((i) => i.end > i.start)
    .sort((x, y) => x.start - y.start);
  const merged: Interval[] = [];
  for (const i of clipped) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}

export interface ElapsedInput {
  start: number;
  /** When the clock stopped; null = still running. */
  stop: number | null;
  now: number;
  pauses: Interval[];
  calendar: '24x7' | 'business';
  hours?: BusinessHours;
}

/** Elapsed (non-paused, calendar-aware) milliseconds for an SLA clock. */
export function computeElapsedMs(input: ElapsedInput): number {
  const end = input.stop ?? input.now;
  if (end <= input.start) return 0;
  const measure = (from: number, to: number) =>
    input.calendar === 'business'
      ? businessMillisBetween(from, to, input.hours ?? DEFAULT_BUSINESS_HOURS)
      : Math.max(0, to - from);

  let total = measure(input.start, end);
  for (const p of normalizeIntervals(input.pauses, input.start, end)) {
    total -= measure(p.start, p.end);
  }
  return Math.max(0, total);
}

export type SlaStatus = 'running' | 'paused' | 'warning' | 'met' | 'breached';

export interface SlaResult {
  slaId: number;
  name: string;
  metric: string;
  targetMs: number;
  elapsedMs: number;
  remainingMs: number;
  status: SlaStatus;
  /** True if target is exceeded (running) or was exceeded at stop time. */
  breached: boolean;
  stoppedAt: string | null;
  /** Jira-style extras, set by computeSlas. */
  startedAt?: string | null;
  /** Projected (running) or actual (breached) breach instant; null while paused or when met. */
  dueAt?: string | null;
  warningAt?: string | null;
  goalId?: number | null;
  /** Name of the calendar the goal is measured in. */
  calendar?: string | null;
  paused?: boolean;
}

export function evaluateSla(args: {
  slaId: number; name: string; metric: string; targetMinutes: number;
  elapsedMs: number; stopped: boolean; paused: boolean; stoppedAt: number | null;
}): SlaResult {
  const targetMs = args.targetMinutes * 60_000;
  const breached = args.elapsedMs > targetMs;
  const status: SlaStatus = args.stopped ? (breached ? 'breached' : 'met') : breached ? 'breached' : args.paused ? 'paused' : 'running';
  return {
    slaId: args.slaId,
    name: args.name,
    metric: args.metric,
    targetMs,
    elapsedMs: args.elapsedMs,
    remainingMs: targetMs - args.elapsedMs,
    status,
    breached,
    stoppedAt: args.stoppedAt ? new Date(args.stoppedAt).toISOString() : null,
  };
}

/** Build pause intervals from chronological status history. */
export function pauseIntervalsFromHistory(
  history: Array<{ at: number; newStatus: string | null }>,
  pauseStatuses: Set<string>,
  now: number,
  initialStatus?: string | null,
  createdAt?: number,
): Interval[] {
  const out: Interval[] = [];
  let pauseStart: number | null = initialStatus && pauseStatuses.has(initialStatus) && createdAt ? createdAt : null;
  for (const h of [...history].sort((a, b) => a.at - b.at)) {
    const paused = h.newStatus !== null && pauseStatuses.has(h.newStatus);
    if (paused && pauseStart === null) pauseStart = h.at;
    else if (!paused && pauseStart !== null) {
      out.push({ start: pauseStart, end: h.at });
      pauseStart = null;
    }
  }
  if (pauseStart !== null) out.push({ start: pauseStart, end: now });
  return out;
}
