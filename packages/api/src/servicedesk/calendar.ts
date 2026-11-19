/**
 * SLA calendars (Jira Service Management style): time zone, working hours per weekday with several
 * intervals, and holidays. Pure functions; all arithmetic is DST safe because working intervals are
 * built per local calendar day and converted to UTC with the zone's real offset on that day.
 */
import type { BusinessHours } from './sla'

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export const DAY_KEYS: readonly DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface Holiday {
  /** YYYY-MM-DD */
  date: string
  name?: string
  /** Repeats every year on the same month and day. */
  recurring?: boolean
}

export interface Calendar {
  /** 24/7: ignores hours, zone and holidays. */
  always?: boolean
  /** IANA zone, default UTC. */
  timeZone?: string
  /** Fixed offset, only used when no timeZone is set (legacy desk business hours). */
  utcOffsetMinutes?: number
  /** "HH:MM" pairs; end may be "24:00". Missing/empty day = not working. */
  days: Partial<Record<DayKey, Array<[string, string]>>>
  holidays?: Holiday[]
}

export interface Interval { start: number; end: number }

export const ALWAYS_OPEN: Calendar = { always: true, days: {} }

export const SAMPLE_9_TO_5: Calendar = {
  timeZone: 'UTC',
  days: Object.fromEntries((['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]).map((d) => [d, [['09:00', '17:00']]])),
}

/** Desk-level legacy `business_hours` JSON as a calendar. */
export function calendarFromBusinessHours(bh: BusinessHours): Calendar {
  return { utcOffsetMinutes: bh.utcOffsetMinutes ?? 0, days: bh.days as Calendar['days'] }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    dtfCache.set(tz, f)
  }
  return f
}

/** Offset (ms) of `tz` from UTC at the instant `ms`: local = utc + offset. */
const offsetCache = new Map<string, number>()
export function zoneOffsetMs(ms: number, tz: string): number {
  // transitions happen on 15-minute UTC boundaries, so a 15-minute bucket is exact and keeps this cheap
  const key = `${tz}|${Math.floor(ms / 900_000)}`
  const hit = offsetCache.get(key)
  if (hit !== undefined) return hit
  if (offsetCache.size > 50_000) offsetCache.clear()
  const v = computeZoneOffset(ms, tz)
  offsetCache.set(key, v)
  return v
}

function computeZoneOffset(ms: number, tz: string): number {
  const parts = dtf(tz).formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - Math.floor(ms / 1000) * 1000
}

function offsetAt(cal: Calendar, ms: number): number {
  if (cal.timeZone) return zoneOffsetMs(ms, cal.timeZone)
  return (cal.utcOffsetMinutes ?? 0) * 60_000
}

/** UTC instant of a local wall-clock time in the calendar's zone (handles DST gaps/overlaps). */
function localToUtc(cal: Calendar, y: number, m: number, d: number, minutesOfDay: number): number {
  const naive = Date.UTC(y, m, d, 0, minutesOfDay)
  const o1 = offsetAt(cal, naive)
  let guess = naive - o1
  const o2 = offsetAt(cal, guess)
  if (o2 !== o1) guess = naive - o2
  return guess
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function isHoliday(cal: Calendar, y: number, m: number, d: number): boolean {
  const full = `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`
  const md = full.slice(5)
  return (cal.holidays ?? []).some((h) => (h.recurring ? h.date.slice(5) === md : h.date === full))
}

const MAX_DAYS = 3700

/**
 * Working intervals (UTC ms, sorted, non-overlapping) that intersect [from, to].
 * Not clipped to [from, to]; callers clip.
 */
function* dayIntervals(cal: Calendar, from: number): Generator<Interval> {
  // local calendar date containing `from` (look one day back so a zone ahead of UTC is covered)
  const off = offsetAt(cal, from)
  const local = new Date(from + off)
  let y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate()
  for (let i = 0; i < MAX_DAYS; i++) {
    const date = new Date(Date.UTC(y, m, d + i))
    const yy = date.getUTCFullYear(), mm = date.getUTCMonth(), dd = date.getUTCDate()
    if (isHoliday(cal, yy, mm, dd)) continue
    const wins = cal.days[DAY_KEYS[date.getUTCDay()]] ?? []
    const sorted = [...wins].sort((a, b) => hmToMinutes(a[0]) - hmToMinutes(b[0]))
    for (const [s, e] of sorted) {
      const sm = hmToMinutes(s), em = hmToMinutes(e)
      if (em <= sm) continue
      yield { start: localToUtc(cal, yy, mm, dd, sm), end: localToUtc(cal, yy, mm, dd, em) }
    }
  }
}

/** Milliseconds of working time within [from, to]. */
export function workingMillis(cal: Calendar, from: number, to: number): number {
  if (to <= from) return 0
  if (cal.always) return to - from
  let total = 0
  for (const iv of dayIntervals(cal, from)) {
    if (iv.start >= to) break
    const lo = Math.max(iv.start, from), hi = Math.min(iv.end, to)
    if (hi > lo) total += hi - lo
  }
  return total
}

/** Working intervals clipped to [from, to]. */
export function workingIntervals(cal: Calendar, from: number, to: number): Interval[] {
  if (to <= from) return []
  if (cal.always) return [{ start: from, end: to }]
  const out: Interval[] = []
  for (const iv of dayIntervals(cal, from)) {
    if (iv.start >= to) break
    const lo = Math.max(iv.start, from), hi = Math.min(iv.end, to)
    if (hi > lo) out.push({ start: lo, end: hi })
  }
  return out
}

/** The instant at which `durationMs` of working time has elapsed after `from`; null if never (empty calendar). */
export function addWorkingMillis(cal: Calendar, from: number, durationMs: number): number | null {
  if (durationMs <= 0) return from
  if (cal.always) return from + durationMs
  let left = durationMs
  for (const iv of dayIntervals(cal, from)) {
    const lo = Math.max(iv.start, from)
    if (iv.end <= lo) continue
    const room = iv.end - lo
    if (left <= room) return lo + left
    left -= room
  }
  return null
}

/** Whether `ms` falls inside working time. */
export function isWorkingAt(cal: Calendar, ms: number): boolean {
  return workingMillis(cal, ms, ms + 1) > 0
}

/* ---- validation of stored/posted calendar data ---- */

export function validateWorkingHours(days: Calendar['days']): string[] {
  const errors: string[] = []
  for (const key of DAY_KEYS) {
    const wins = days[key] ?? []
    const parsed: Array<[number, number]> = []
    for (const [s, e] of wins) {
      const re = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s) || !re.test(e)) { errors.push(`${key}: invalid time "${s}"-"${e}"`); continue }
      const sm = hmToMinutes(s), em = hmToMinutes(e)
      if (em <= sm) { errors.push(`${key}: end must be after start (${s}-${e})`); continue }
      parsed.push([sm, em])
    }
    parsed.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i][0] < parsed[i - 1][1]) { errors.push(`${key}: intervals overlap`); break }
    }
  }
  return errors
}
