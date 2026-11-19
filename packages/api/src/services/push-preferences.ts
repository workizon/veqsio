/**
 * What a person wants pushed to their browsers, and when. Pure rules (no database) so they can be tested exhaustively; the
 * loading and saving live in routes/push.ts and services/push.ts.
 *
 * - Each kind of push can be switched off. A missing switch means on, so new kinds are on for everybody.
 * - Quiet hours silence everything except urgent kinds (on-call pages), in the person's own time zone. A window may cross midnight
 *   (22:00 to 07:00). Start equal to end means no quiet hours.
 */
export const PUSH_KINDS = ['assignment', 'mention', 'comment', 'oncall'] as const
export type PushKind = (typeof PUSH_KINDS)[number]
/** Kinds that ignore quiet hours: somebody is paged and has to know. They can still be switched off completely. */
export const URGENT_KINDS: ReadonlySet<PushKind> = new Set<PushKind>(['oncall'])

export const PUSH_KIND_LABELS: Record<PushKind, string> = {
  assignment: 'An issue is assigned to me',
  mention: 'Someone mentions me in a comment',
  comment: 'Someone comments on an issue I follow',
  oncall: 'I am paged as on call (also during quiet hours)',
}

export interface PushPrefs {
  events: Record<string, boolean>
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timezone: string
}

export const DEFAULT_PREFS: PushPrefs = { events: {}, quietEnabled: false, quietStart: '22:00', quietEnd: '07:00', timezone: 'UTC' }

export const isHHMM = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true } catch { return false }
}

/** Minutes since midnight at `now` in the given time zone. */
export function minutesOfDayIn(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return (h % 24) * 60 + m
}

export function inQuietHours(p: PushPrefs, now: Date): boolean {
  if (!p.quietEnabled || !isHHMM(p.quietStart) || !isHHMM(p.quietEnd) || p.quietStart === p.quietEnd) return false
  const tz = validTimeZone(p.timezone) ? p.timezone : 'UTC'
  const t = minutesOfDayIn(tz, now)
  const a = minutes(p.quietStart)
  const b = minutes(p.quietEnd)
  return a < b ? t >= a && t < b : t >= a || t < b
}

/** Whether a push of this kind should go to this person now. People who never set anything (no row) get everything. */
export function shouldPush(p: PushPrefs | undefined, kind: PushKind, now: Date): boolean {
  if (!p) return true
  if (p.events[kind] === false) return false
  if (URGENT_KINDS.has(kind)) return true
  return !inQuietHours(p, now)
}

/** The switches with every kind spelled out (for the settings screen). */
export function resolvedEvents(events: Record<string, boolean>): Record<PushKind, boolean> {
  return Object.fromEntries(PUSH_KINDS.map((k) => [k, events[k] !== false])) as Record<PushKind, boolean>
}
