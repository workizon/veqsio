import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { getDeskRole, isStaff, type DeskRole } from '../servicedesk/service'
import {
  addWorkingMillis, isValidTimeZone, validateWorkingHours, workingMillis, type Calendar, type Holiday,
} from '../servicedesk/calendar'
import { ensureDefaultCalendars, rowToCalendar } from '../servicedesk/calendar-store'
import { CONDITION_EVENTS, legacyConditions, type SlaCondition } from '../servicedesk/sla-engine'
import { validateGoalJql } from '../servicedesk/goal-filter'

/**
 * SLA administration for a service desk (Jira Service Management style):
 * calendars (time zone, working hours, holidays) and SLA metrics (start/pause/stop conditions, goals).
 * Reading SLA metrics is open to agents; everything else needs desk admin.
 */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403)
const bad = (c: any, ...errorMessages: string[]) => c.json({ errorMessages }, 400)
const isResponse = (v: unknown): v is Response => v instanceof Response

type Desk = typeof schema.serviceDesks.$inferSelect

async function guard(c: any, minRole: 'agent' | 'admin'): Promise<{ desk: Desk; role: DeskRole } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return notFound(c)
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  if (!desk) return notFound(c)
  const role = await getDeskRole(c.get('user'), desk)
  if (!isStaff(role)) return notFound(c) // no desk enumeration
  if (minRole === 'admin' && role !== 'admin') return forbidden(c)
  return { desk, role }
}

/** zod validation with the API-wide `{ errorMessages: [] }` error shape. */
const zv = <T extends z.ZodTypeAny>(schema: T) =>
  zValidator('json', schema, (r, c) => {
    if (!r.success) return c.json({ errorMessages: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400)
  })

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')
const hmEnd = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'must be HH:MM')
const dayList = z.array(z.tuple([hm, hmEnd])).max(8)
const workingHours = z.object({
  mon: dayList.optional(), tue: dayList.optional(), wed: dayList.optional(), thu: dayList.optional(),
  fri: dayList.optional(), sat: dayList.optional(), sun: dayList.optional(),
}).strict()

const holidayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), 'invalid date'),
  name: z.string().trim().min(1).max(255),
  recurring: z.boolean().default(false),
}).strict()

const timeZone = z.string().max(64).refine(isValidTimeZone, 'unknown time zone')

const calendarBody = z.object({
  name: z.string().trim().min(1).max(255),
  timeZone: timeZone.default('UTC'),
  workingHours: workingHours.default({}),
  holidays: z.array(holidayBody).max(500).optional(), // replace-all when present
}).strict()

const previewBody = z.object({
  calendarId: z.number().int().optional(),
  /** Unsaved calendar from the editor. */
  calendar: z.object({
    always: z.boolean().optional(),
    timeZone: timeZone.default('UTC'),
    workingHours: workingHours.default({}),
    holidays: z.array(holidayBody).max(500).default([]),
  }).strict().optional(),
  start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date-time'),
  durationMinutes: z.number().int().min(0).max(525_600),
}).strict().refine((b) => b.calendarId != null || b.calendar != null, 'calendarId or calendar is required')

const condition = z.object({
  event: z.enum(CONDITION_EVENTS as unknown as [string, ...string[]]),
  statusIds: z.array(z.number().int()).max(50).optional(),
  restart: z.boolean().optional(),
}).strict().superRefine((c, ctx) => {
  if ((c.event === 'status_entered' || c.event === 'status_exited') && !c.statusIds?.length)
    ctx.addIssue({ code: 'custom', message: `${c.event} needs at least one status` })
})

const criteria = z.object({
  priorityIds: z.array(z.number().int()).max(50).optional(),
  issueTypeIds: z.array(z.number().int()).max(50).optional(),
  requestTypeIds: z.array(z.number().int()).max(100).optional(),
}).strict()

const goalBody = z.object({
  priorityId: z.number().int().nullable().optional(), // legacy single-priority goals
  criteria: criteria.default({}),
  jql: z.string().trim().max(2000).nullable().optional(),
  targetMinutes: z.number().int().min(1).max(525_600),
  calendarId: z.number().int().nullable().optional(),
}).strict()

const slaBody = z.object({
  name: z.string().trim().min(1).max(255),
  metric: z.enum(['first_response', 'resolution', 'custom']).default('custom'),
  calendar: z.enum(['24x7', 'business']).default('24x7'), // legacy; superseded by calendarId
  calendarId: z.number().int().nullable().optional(),
  pauseStatusIds: z.array(z.number().int()).max(50).default([]), // legacy implicit pause condition
  startConditions: z.array(condition).max(20).default([]),
  pauseConditions: z.array(condition).max(20).default([]),
  stopConditions: z.array(condition).max(20).default([]),
  warningPercent: z.number().int().min(1).max(99).nullable().optional(),
  goals: z.array(goalBody).min(1).max(30), // replace-all; array order is evaluation order
}).strict()

/* ------------------------------------------------------------------ */
/*  Calendars                                                          */
/* ------------------------------------------------------------------ */

const BASE = '/rest/servicedeskapi/servicedesk/:id'

type CalRow = typeof schema.slaCalendars.$inferSelect
type HolRow = typeof schema.slaCalendarHolidays.$inferSelect

const calView = (r: CalRow, hol: HolRow[]) => ({
  id: r.id, name: r.name, builtIn: r.kind === '24x7', kind: r.kind, timeZone: r.timeZone, workingHours: r.workingHours,
  holidays: hol.filter((h) => h.calendarId === r.id).sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => ({ id: h.id, date: h.date, name: h.name, recurring: h.recurring })),
})

async function calendarsOf(deskId: number) {
  const rows = await db.select().from(schema.slaCalendars).where(eq(schema.slaCalendars.serviceDeskId, deskId)).orderBy(asc(schema.slaCalendars.id))
  const hol = rows.length ? await db.select().from(schema.slaCalendarHolidays).where(inArray(schema.slaCalendarHolidays.calendarId, rows.map((r) => r.id))) : []
  return { rows, hol }
}

async function getCalendar(deskId: number, cid: number) {
  if (!Number.isInteger(cid)) return null
  const [row] = await db.select().from(schema.slaCalendars)
    .where(and(eq(schema.slaCalendars.id, cid), eq(schema.slaCalendars.serviceDeskId, deskId))).limit(1)
  if (!row) return null
  const hol = await db.select().from(schema.slaCalendarHolidays).where(eq(schema.slaCalendarHolidays.calendarId, cid))
  return { row, hol }
}

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.cause?.message ?? e?.message ?? ''))

app.get(`${BASE}/calendar`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  await ensureDefaultCalendars(g.desk)
  const { rows, hol } = await calendarsOf(g.desk.id)
  return c.json({ values: rows.map((r) => calView(r, hol)) })
})

app.post(`${BASE}/calendar`, requireAuth, zv(calendarBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const errs = validateWorkingHours(b.workingHours as Calendar['days'])
  if (errs.length) return bad(c, ...errs)
  await ensureDefaultCalendars(g.desk)
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.slaCalendars).values({
        serviceDeskId: g.desk.id, name: b.name, timeZone: b.timeZone, workingHours: b.workingHours,
      }).returning()
      const hol = b.holidays?.length
        ? await tx.insert(schema.slaCalendarHolidays).values(b.holidays.map((h) => ({ ...h, calendarId: row.id }))).returning()
        : []
      return calView(row, hol)
    })
    return c.json(created, 201)
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ errorMessages: ['A calendar with this name already exists'] }, 409)
    throw e
  }
})

// Declared before /calendar/:cid so "preview" is never read as an id.
app.post(`${BASE}/calendar/preview`, requireAuth, zv(previewBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  let cal: Calendar
  let name: string | null = null
  if (b.calendarId != null) {
    const got = await getCalendar(g.desk.id, b.calendarId)
    if (!got) return notFound(c)
    name = got.row.name
    cal = rowToCalendar(got.row, got.hol.map((h) => ({ date: h.date, name: h.name, recurring: h.recurring })))
  } else {
    const k = b.calendar!
    const errs = validateWorkingHours(k.workingHours as Calendar['days'])
    if (errs.length) return bad(c, ...errs)
    cal = k.always ? { always: true, days: {} } : { timeZone: k.timeZone, days: k.workingHours as Calendar['days'], holidays: k.holidays as Holiday[] }
  }
  const start = Date.parse(b.start)
  const due = addWorkingMillis(cal, start, b.durationMinutes * 60_000)
  return c.json({
    calendar: name,
    start: new Date(start).toISOString(),
    durationMinutes: b.durationMinutes,
    due: due == null ? null : new Date(due).toISOString(),
    // wall-clock time between start and due, to show how much non-working time was skipped
    elapsedMinutes: due == null ? null : Math.round((due - start) / 60_000),
    workingMinutes: due == null ? null : Math.round(workingMillis(cal, start, due) / 60_000),
    message: due == null ? 'This calendar has no working time, so the goal can never be reached' : null,
  })
})

app.get(`${BASE}/calendar/:cid`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const got = await getCalendar(g.desk.id, Number(c.req.param('cid')))
  return got ? c.json(calView(got.row, got.hol)) : notFound(c)
})

app.put(`${BASE}/calendar/:cid`, requireAuth, zv(calendarBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const got = await getCalendar(g.desk.id, Number(c.req.param('cid')))
  if (!got) return notFound(c)
  if (got.row.kind === '24x7') return c.json({ errorMessages: ['The built-in 24/7 calendar cannot be changed'] }, 409)
  const b = c.req.valid('json')
  const errs = validateWorkingHours(b.workingHours as Calendar['days'])
  if (errs.length) return bad(c, ...errs)
  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.slaCalendars).set({ name: b.name, timeZone: b.timeZone, workingHours: b.workingHours })
        .where(eq(schema.slaCalendars.id, got.row.id)).returning()
      let hol = got.hol
      if (b.holidays) {
        await tx.delete(schema.slaCalendarHolidays).where(eq(schema.slaCalendarHolidays.calendarId, row.id))
        hol = b.holidays.length ? await tx.insert(schema.slaCalendarHolidays).values(b.holidays.map((h) => ({ ...h, calendarId: row.id }))).returning() : []
      }
      return calView(row, hol)
    })
    return c.json(updated)
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ errorMessages: ['A calendar with this name already exists'] }, 409)
    throw e
  }
})

app.delete(`${BASE}/calendar/:cid`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const got = await getCalendar(g.desk.id, Number(c.req.param('cid')))
  if (!got) return notFound(c)
  if (got.row.kind === '24x7') return c.json({ errorMessages: ['The built-in 24/7 calendar cannot be deleted'] }, 409)
  const slas = await db.select({ id: schema.slaDefinitions.id }).from(schema.slaDefinitions).where(eq(schema.slaDefinitions.calendarId, got.row.id)).limit(1)
  const goals = await db.select({ id: schema.slaGoals.id }).from(schema.slaGoals).where(eq(schema.slaGoals.calendarId, got.row.id)).limit(1)
  if (slas.length || goals.length) return c.json({ errorMessages: ['This calendar is used by an SLA and cannot be deleted'] }, 409)
  await db.delete(schema.slaCalendars).where(eq(schema.slaCalendars.id, got.row.id))
  return c.body(null, 204)
})

app.post(`${BASE}/calendar/:cid/holiday`, requireAuth, zv(holidayBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const got = await getCalendar(g.desk.id, Number(c.req.param('cid')))
  if (!got) return notFound(c)
  if (got.row.kind === '24x7') return c.json({ errorMessages: ['The built-in 24/7 calendar has no holidays'] }, 409)
  const [h] = await db.insert(schema.slaCalendarHolidays).values({ ...c.req.valid('json'), calendarId: got.row.id }).returning()
  return c.json({ id: h.id, date: h.date, name: h.name, recurring: h.recurring }, 201)
})

app.delete(`${BASE}/calendar/:cid/holiday/:hid`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const got = await getCalendar(g.desk.id, Number(c.req.param('cid')))
  if (!got) return notFound(c)
  const r = await db.delete(schema.slaCalendarHolidays)
    .where(and(eq(schema.slaCalendarHolidays.id, Number(c.req.param('hid')) || -1), eq(schema.slaCalendarHolidays.calendarId, got.row.id)))
    .returning({ id: schema.slaCalendarHolidays.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

/* ------------------------------------------------------------------ */
/*  SLA metrics                                                        */
/* ------------------------------------------------------------------ */

type SlaRow = typeof schema.slaDefinitions.$inferSelect
type GoalRow = typeof schema.slaGoals.$inferSelect

function slaView(d: SlaRow, goals: GoalRow[]) {
  const legacy = legacyConditions(d.metric, (d.pauseStatusIds as number[]) ?? [])
  const lists = {
    start: (d.startConditions as SlaCondition[]) ?? [],
    pause: (d.pauseConditions as SlaCondition[]) ?? [],
    stop: (d.stopConditions as SlaCondition[]) ?? [],
  }
  return {
    ...d,
    goals: goals.filter((x) => x.slaId === d.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((x) => ({ ...x, criteria: x.criteria ?? {} })),
    // what the engine actually runs: stored conditions, or the legacy defaults when none were configured
    effectiveConditions: {
      start: lists.start.length ? lists.start : legacy.start,
      pause: lists.pause.length ? lists.pause : legacy.pause,
      stop: lists.stop.length ? lists.stop : legacy.stop,
    },
    usesLegacyConditions: !lists.start.length && !lists.pause.length && !lists.stop.length,
  }
}

/** Cross-field checks that need the database. Returns error messages. */
async function validateSla(desk: Desk, b: z.infer<typeof slaBody>): Promise<string[]> {
  const errors: string[] = []
  const calIds = [...new Set([b.calendarId, ...b.goals.map((x) => x.calendarId)].filter((x): x is number => typeof x === 'number'))]
  if (calIds.length) {
    const found = await db.select({ id: schema.slaCalendars.id }).from(schema.slaCalendars)
      .where(and(eq(schema.slaCalendars.serviceDeskId, desk.id), inArray(schema.slaCalendars.id, calIds)))
    if (found.length !== calIds.length) errors.push('Unknown calendar')
  }
  const statusIds = [...new Set([
    ...b.pauseStatusIds,
    ...[...b.startConditions, ...b.pauseConditions, ...b.stopConditions].flatMap((c) => c.statusIds ?? []),
  ])]
  if (statusIds.length) {
    const found = await db.select({ id: schema.statuses.id }).from(schema.statuses).where(inArray(schema.statuses.id, statusIds))
    if (found.length !== statusIds.length) errors.push('Unknown status in conditions')
  }
  if (b.pauseConditions.some((c) => c.restart) || b.stopConditions.some((c) => c.restart)) errors.push('restart is only valid on start conditions')
  for (const [i, goal] of b.goals.entries()) {
    if (goal.jql) {
      const e = await validateGoalJql(goal.jql)
      if (e) errors.push(`Goal ${i + 1}: invalid JQL (${e})`)
    }
  }
  return errors
}

const goalValues = (slaId: number, goals: z.infer<typeof slaBody>['goals']) =>
  goals.map((x, i) => ({
    slaId, sortOrder: i, targetMinutes: x.targetMinutes, priorityId: x.priorityId ?? null, criteria: x.criteria,
    jql: x.jql || null, calendarId: x.calendarId ?? null,
  }))

async function defValues(desk: Desk, b: z.infer<typeof slaBody>) {
  let calendar: string = b.calendar
  if (b.calendarId != null) {
    const [cal] = await db.select({ kind: schema.slaCalendars.kind }).from(schema.slaCalendars).where(eq(schema.slaCalendars.id, b.calendarId)).limit(1)
    calendar = cal?.kind === '24x7' ? '24x7' : 'business' // keep the legacy column meaningful
  }
  const { goals: _g, ...rest } = b
  return { ...rest, calendar, calendarId: b.calendarId ?? null, warningPercent: b.warningPercent ?? null }
}

app.get(`${BASE}/sla`, requireAuth, async (c) => {
  const g = await guard(c, 'agent'); if (isResponse(g)) return g
  if (g.role === 'admin') await ensureDefaultCalendars(g.desk) // back-fills legacy 24x7/business SLAs with calendars
  const defs = await db.select().from(schema.slaDefinitions).where(eq(schema.slaDefinitions.serviceDeskId, g.desk.id))
    .orderBy(asc(schema.slaDefinitions.sortOrder), asc(schema.slaDefinitions.id))
  const goals = defs.length ? await db.select().from(schema.slaGoals).where(inArray(schema.slaGoals.slaId, defs.map((d) => d.id))) : []
  return c.json({ values: defs.map((d) => slaView(d, goals)) })
})

app.post(`${BASE}/sla`, requireAuth, zv(slaBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const errs = await validateSla(g.desk, b)
  if (errs.length) return bad(c, ...errs)
  const values = await defValues(g.desk, b)
  const created = await db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.slaDefinitions).where(eq(schema.slaDefinitions.serviceDeskId, g.desk.id))
    const [s] = await tx.insert(schema.slaDefinitions).values({ ...values, serviceDeskId: g.desk.id, sortOrder: n }).returning()
    const gs = await tx.insert(schema.slaGoals).values(goalValues(s.id, b.goals)).returning()
    return slaView(s, gs)
  })
  return c.json(created, 201)
})

app.put(`${BASE}/sla/:slaId`, requireAuth, zv(slaBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const slaId = Number(c.req.param('slaId'))
  if (!Number.isInteger(slaId)) return notFound(c)
  const b = c.req.valid('json')
  const errs = await validateSla(g.desk, b)
  if (errs.length) return bad(c, ...errs)
  const values = await defValues(g.desk, b)
  const updated = await db.transaction(async (tx) => {
    const [s] = await tx.update(schema.slaDefinitions).set(values)
      .where(and(eq(schema.slaDefinitions.id, slaId), eq(schema.slaDefinitions.serviceDeskId, g.desk.id))).returning()
    if (!s) return null
    await tx.delete(schema.slaGoals).where(eq(schema.slaGoals.slaId, slaId))
    const gs = await tx.insert(schema.slaGoals).values(goalValues(slaId, b.goals)).returning()
    return slaView(s, gs)
  })
  return updated ? c.json(updated) : notFound(c)
})

/** Reorder SLA metrics: body is the full list of SLA ids in the wanted order. */
app.put(`${BASE}/sla-order`, requireAuth, zv(z.object({ ids: z.array(z.number().int()).min(1).max(100) }).strict()), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const { ids } = c.req.valid('json')
  const own = await db.select({ id: schema.slaDefinitions.id }).from(schema.slaDefinitions).where(eq(schema.slaDefinitions.serviceDeskId, g.desk.id))
  if (own.length !== ids.length || !own.every((o) => ids.includes(o.id))) return bad(c, 'ids must list every SLA of the desk exactly once')
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(schema.slaDefinitions).set({ sortOrder: i }).where(eq(schema.slaDefinitions.id, id))
  })
  return c.body(null, 204)
})

app.delete(`${BASE}/sla/:slaId`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const r = await db.delete(schema.slaDefinitions)
    .where(and(eq(schema.slaDefinitions.id, Number(c.req.param('slaId')) || -1), eq(schema.slaDefinitions.serviceDeskId, g.desk.id)))
    .returning({ id: schema.slaDefinitions.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

export default app
