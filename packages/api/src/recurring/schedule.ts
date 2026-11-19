/**
 * Pure schedule maths for recurring issues (no database): given a rule and a moment, when is the next slot?
 * Slots are wall-clock times in the rule's IANA timezone, so "09:00 every weekday" stays at 09:00 across DST changes.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface ScheduleRule {
  frequency: Frequency;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. Used by 'weekly'; an empty list means Monday to Friday. */
  daysOfWeek?: number[];
  /** 1..31 for 'monthly'; months that are shorter run on their last day. */
  dayOfMonth?: number | null;
  /** 'HH:MM', 24 hour clock. */
  timeOfDay: string;
  timezone: string;
}

export const WEEKDAYS = [1, 2, 3, 4, 5];

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz.length > 0 && tz.length <= 64; } catch { return false; }
}

export function parseTimeOfDay(t: string): { h: number; m: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/** Validation message or null. */
export function validateRule(r: ScheduleRule): string | null {
  if (!['daily', 'weekly', 'monthly'].includes(r.frequency)) return 'frequency must be daily, weekly or monthly';
  if (!parseTimeOfDay(r.timeOfDay)) return 'timeOfDay must be HH:MM (24 hour clock)';
  if (!isValidTimezone(r.timezone)) return 'timezone must be a valid IANA time zone such as Europe/Berlin';
  if (r.frequency === 'weekly') {
    const d = r.daysOfWeek ?? [];
    if (d.some((x) => !Number.isInteger(x) || x < 1 || x > 7) || new Set(d).size !== d.length) return 'daysOfWeek must be unique numbers from 1 (Monday) to 7 (Sunday)';
  }
  if (r.frequency === 'monthly') {
    if (!Number.isInteger(r.dayOfMonth) || (r.dayOfMonth as number) < 1 || (r.dayOfMonth as number) > 31) return 'dayOfMonth must be a whole number from 1 to 31';
  }
  return null;
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

function partsInZone(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

/** Offset (zone minus UTC) in milliseconds at the given instant. */
function offsetAt(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows the given local time (a time inside a DST gap moves forward). */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ms = guess - offsetAt(guess, tz);
  ms = guess - offsetAt(ms, tz);
  return new Date(ms);
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const isoWeekday = (y: number, mo: number, d: number) => ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1;

function matches(rule: ScheduleRule, y: number, mo: number, d: number): boolean {
  switch (rule.frequency) {
    case 'daily': return true;
    case 'weekly': {
      const days = rule.daysOfWeek && rule.daysOfWeek.length ? rule.daysOfWeek : WEEKDAYS;
      return days.includes(isoWeekday(y, mo, d));
    }
    case 'monthly': return d === Math.min(rule.dayOfMonth ?? 1, daysInMonth(y, mo));
  }
}

/** The first slot strictly after `after`, or null when the rule is invalid / never fires. */
export function nextOccurrence(rule: ScheduleRule, after: Date): Date | null {
  if (validateRule(rule)) return null;
  const t = parseTimeOfDay(rule.timeOfDay)!;
  const start = partsInZone(after.getTime(), rule.timezone);
  // Walk calendar days (UTC arithmetic, only the date part matters); a monthly rule needs at most ~13 months of days.
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!matches(rule, y, mo, d)) continue;
    const cand = zonedTimeToUtc(y, mo, d, t.h, t.m, rule.timezone);
    if (cand.getTime() > after.getTime()) return cand;
  }
  return null;
}

/** Local calendar parts of an instant in a zone, for summary placeholders. */
export function localParts(at: Date, tz: string): { year: number; month: number; day: number; weekday: number } {
  const p = partsInZone(at.getTime(), tz);
  return { year: p.y, month: p.mo, day: p.d, weekday: isoWeekday(p.y, p.mo, p.d) };
}
