/**
 * Persistence helpers for SLA calendars: built-in calendars, legacy back-fill and row -> engine mapping.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { SAMPLE_9_TO_5, isValidTimeZone, calendarFromBusinessHours, type Calendar, type Holiday } from './calendar'
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from './sla'

type Desk = typeof schema.serviceDesks.$inferSelect
type CalendarRow = typeof schema.slaCalendars.$inferSelect

export const CALENDAR_24_7 = '24/7'
export const CALENDAR_SAMPLE = 'Sample 9-5 Calendar'
export const CALENDAR_LEGACY = 'Business hours (migrated)'

export function rowToCalendar(row: Pick<CalendarRow, 'kind' | 'timeZone' | 'workingHours'>, holidays: Holiday[] = []): Calendar {
  if (row.kind === '24x7') return { always: true, days: {} }
  return { timeZone: row.timeZone, days: (row.workingHours ?? {}) as Calendar['days'], holidays }
}

/** Legacy desk offset (minutes) as a fixed-offset IANA zone (Etc/GMT signs are inverted); UTC if no whole-hour match. */
export function offsetToZone(offsetMinutes: number | undefined): string {
  const o = offsetMinutes ?? 0
  if (o === 0 || o % 60 !== 0) return 'UTC'
  const zone = `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o / 60)}`
  return isValidTimeZone(zone) ? zone : 'UTC'
}

/**
 * Makes sure a desk has the built-in "24/7" and "Sample 9-5 Calendar" calendars, and back-fills SLA
 * definitions that predate calendars (`calendar` = '24x7' | 'business' with no calendarId):
 * 'business' points at a "Business hours (migrated)" calendar built from the desk's business_hours JSON.
 * Idempotent; the engine also falls back to the legacy columns when calendarId is null.
 */
export async function ensureDefaultCalendars(desk: Desk): Promise<void> {
  await db.insert(schema.slaCalendars).values([
    { serviceDeskId: desk.id, name: CALENDAR_24_7, kind: '24x7', timeZone: 'UTC', workingHours: {} },
    { serviceDeskId: desk.id, name: CALENDAR_SAMPLE, kind: 'custom', timeZone: 'UTC', workingHours: SAMPLE_9_TO_5.days },
  ]).onConflictDoNothing()

  const legacy = await db.select({ id: schema.slaDefinitions.id, calendar: schema.slaDefinitions.calendar })
    .from(schema.slaDefinitions)
    .where(and(eq(schema.slaDefinitions.serviceDeskId, desk.id), isNull(schema.slaDefinitions.calendarId)))
  if (legacy.length === 0) return

  const byName = async (name: string) =>
    (await db.select().from(schema.slaCalendars)
      .where(and(eq(schema.slaCalendars.serviceDeskId, desk.id), eq(schema.slaCalendars.name, name))).limit(1))[0]

  const always = await byName(CALENDAR_24_7)
  const business = legacy.filter((l) => l.calendar === 'business').map((l) => l.id)
  const open = legacy.filter((l) => l.calendar !== 'business').map((l) => l.id)
  if (open.length && always) {
    await db.update(schema.slaDefinitions).set({ calendarId: always.id }).where(inArray(schema.slaDefinitions.id, open))
  }
  if (business.length) {
    const bh = (desk.businessHours as BusinessHours | null) ?? DEFAULT_BUSINESS_HOURS
    await db.insert(schema.slaCalendars).values({
      serviceDeskId: desk.id, name: CALENDAR_LEGACY, kind: 'custom', timeZone: offsetToZone(bh.utcOffsetMinutes),
      workingHours: calendarFromBusinessHours(bh).days,
    }).onConflictDoNothing()
    const cal = await byName(CALENDAR_LEGACY)
    if (cal) await db.update(schema.slaDefinitions).set({ calendarId: cal.id }).where(inArray(schema.slaDefinitions.id, business))
  }
}

export interface LoadedCalendar { id: number; name: string; calendar: Calendar }

/** All calendars of a desk keyed by id, with holidays. */
export async function loadDeskCalendars(deskId: number): Promise<Map<number, LoadedCalendar>> {
  const rows = await db.select().from(schema.slaCalendars).where(eq(schema.slaCalendars.serviceDeskId, deskId))
  const out = new Map<number, LoadedCalendar>()
  if (rows.length === 0) return out
  const hol = await db.select().from(schema.slaCalendarHolidays).where(inArray(schema.slaCalendarHolidays.calendarId, rows.map((r) => r.id)))
  for (const r of rows) {
    const hs: Holiday[] = hol.filter((h) => h.calendarId === r.id).map((h) => ({ date: h.date, name: h.name, recurring: h.recurring }))
    out.set(r.id, { id: r.id, name: r.name, calendar: rowToCalendar(r, hs) })
  }
  return out
}
