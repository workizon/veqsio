/**
 * Summary patterns of issue templates. Placeholders (unknown ones stay as typed):
 *   {date} 2026-03-09   {year} 2026   {month} 03   {monthName} March   {day} 09
 *   {week} 11 (ISO week)   {weekday} Monday   {project} project key
 * Rendering is pure; recurring issues pass the scheduled slot so the title matches the slot, not the moment of execution.
 */
import { localParts } from '../recurring/schedule';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pad = (n: number) => String(n).padStart(2, '0');

export function isoWeek(y: number, m: number, d: number): number {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // the Thursday of this week decides the year
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diff = (date.getTime() - firstThursday.getTime()) / 86400000;
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

export function renderSummaryPattern(pattern: string, opts: { at: Date; timezone?: string; projectKey?: string }): string {
  const p = localParts(opts.at, opts.timezone || 'UTC');
  const vars: Record<string, string> = {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    year: String(p.year), month: pad(p.month), monthName: MONTHS[p.month - 1], day: pad(p.day),
    week: pad(isoWeek(p.year, p.month, p.day)), weekday: DAYS[p.weekday - 1],
    project: opts.projectKey ?? '',
  };
  return pattern.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? vars[k] : all)).trim().slice(0, 255);
}
