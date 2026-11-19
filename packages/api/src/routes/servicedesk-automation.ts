import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { getDeskRole, isStaff, type DeskRole } from '../servicedesk/service'
import { ACTIONS, TRIGGERS, validateRule } from '../servicedesk/automation-rules'

/** Automation rules of a service desk: managed by desk admins, readable by agents. Customers and outsiders get 404. */
const app = new Hono<AppContext>()
const BASE = '/rest/servicedeskapi/servicedesk/:id/automation'
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const isResponse = (v: unknown): v is Response => v instanceof Response
type Desk = typeof schema.serviceDesks.$inferSelect

async function guard(c: any, minRole: 'agent' | 'admin'): Promise<{ desk: Desk; role: DeskRole } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return notFound(c)
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  if (!desk) return notFound(c)
  const role = await getDeskRole(c.get('user'), desk)
  if (!isStaff(role)) return notFound(c)
  if (minRole === 'admin' && role !== 'admin') return c.json({ errorMessages: ['Forbidden'] }, 403)
  return { desk, role }
}

const ruleBody = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(TRIGGERS),
  threshold: z.number().int().nullable().optional(),
  action: z.enum(ACTIONS),
  params: z.object({
    userId: z.number().int().positive().optional(),
    priorityId: z.number().int().positive().optional(),
    status: z.string().trim().max(100).optional(),
    text: z.string().max(2000).optional(),
    slaId: z.number().int().positive().optional(),
    labels: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
    requestTypeId: z.number().int().positive().optional(),
  }).strict().default({}),
  conditions: z.object({
    contains: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    channel: z.enum(['portal', 'email', 'agent', 'api']).optional(),
    requestTypeId: z.number().int().positive().optional(),
  }).strict().default({}),
  enabled: z.boolean().optional(),
}).strict()

/** Everything a rule points at must exist: the user, the priority and the SLA of this desk. */
async function checkRefs(desk: Desk, p: { userId?: number; priorityId?: number; slaId?: number; requestTypeId?: number }, conditions: { requestTypeId?: number } = {}): Promise<string | null> {
  for (const rt of [p.requestTypeId, conditions.requestTypeId]) {
    if (!rt) continue
    const [t] = await db.select({ id: schema.requestTypes.id }).from(schema.requestTypes).where(and(eq(schema.requestTypes.id, rt), eq(schema.requestTypes.serviceDeskId, desk.id))).limit(1)
    if (!t) return 'The request type does not belong to this service desk'
  }
  if (p.userId) {
    const [u] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, p.userId)).limit(1)
    if (!u || u.active === false) return 'The user to reassign to does not exist or is inactive'
  }
  if (p.priorityId) {
    const [pr] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(schema.priorities.id, p.priorityId)).limit(1)
    if (!pr) return 'The priority does not exist'
  }
  if (p.slaId) {
    const [s] = await db.select({ id: schema.slaDefinitions.id }).from(schema.slaDefinitions).where(and(eq(schema.slaDefinitions.id, p.slaId), eq(schema.slaDefinitions.serviceDeskId, desk.id))).limit(1)
    if (!s) return 'The SLA does not belong to this service desk'
  }
  return null
}

const view = (r: typeof schema.sdAutomationRules.$inferSelect, runs = 0) => ({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, threshold: r.threshold, action: r.action, params: r.params, conditions: r.conditions, runs, createdAt: r.createdAt })

app.get(BASE, requireAuth, async (c) => {
  const g = await guard(c, 'agent'); if (isResponse(g)) return g
  const rules = await db.select().from(schema.sdAutomationRules).where(eq(schema.sdAutomationRules.serviceDeskId, g.desk.id)).orderBy(asc(schema.sdAutomationRules.id))
  const counts = await db.select({ ruleId: schema.sdAutomationRuns.ruleId, n: sql<number>`count(*)::int` }).from(schema.sdAutomationRuns).groupBy(schema.sdAutomationRuns.ruleId)
  return c.json({ values: rules.map((r) => view(r, counts.find((x) => x.ruleId === r.id)?.n ?? 0)) })
})

app.post(BASE, requireAuth, zValidator('json', ruleBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const bad = validateRule({ name: b.name, trigger: b.trigger, threshold: b.threshold ?? null, action: b.action, params: b.params, conditions: b.conditions })
  if (bad) return c.json({ errorMessages: [bad] }, 400)
  const ref = await checkRefs(g.desk, b.params, b.conditions); if (ref) return c.json({ errorMessages: [ref] }, 400)
  const [row] = await db.insert(schema.sdAutomationRules).values({ serviceDeskId: g.desk.id, name: b.name, trigger: b.trigger, threshold: b.threshold ?? null, action: b.action, params: b.params, conditions: b.conditions, enabled: b.enabled ?? true, actorId: c.get('user')!.id }).returning()
  return c.json(view(row), 201)
})

app.put(`${BASE}/:rid`, requireAuth, zValidator('json', ruleBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const rid = Number(c.req.param('rid'))
  const b = c.req.valid('json')
  const bad = validateRule({ name: b.name, trigger: b.trigger, threshold: b.threshold ?? null, action: b.action, params: b.params, conditions: b.conditions })
  if (bad) return c.json({ errorMessages: [bad] }, 400)
  const ref = await checkRefs(g.desk, b.params, b.conditions); if (ref) return c.json({ errorMessages: [ref] }, 400)
  const [row] = await db.update(schema.sdAutomationRules).set({ name: b.name, trigger: b.trigger, threshold: b.threshold ?? null, action: b.action, params: b.params, conditions: b.conditions, enabled: b.enabled ?? true, actorId: c.get('user')!.id })
    .where(and(eq(schema.sdAutomationRules.id, rid), eq(schema.sdAutomationRules.serviceDeskId, g.desk.id))).returning()
  if (!row) return notFound(c)
  return c.json(view(row))
})

app.delete(`${BASE}/:rid`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const rid = Number(c.req.param('rid'))
  const res = await db.delete(schema.sdAutomationRules).where(and(eq(schema.sdAutomationRules.id, rid), eq(schema.sdAutomationRules.serviceDeskId, g.desk.id))).returning({ id: schema.sdAutomationRules.id })
  if (!res.length) return notFound(c)
  return c.json({})
})

// Recent executions of one rule (agents may look; useful to see what the rule did).
app.get(`${BASE}/:rid/runs`, requireAuth, async (c) => {
  const g = await guard(c, 'agent'); if (isResponse(g)) return g
  const rid = Number(c.req.param('rid'))
  const [rule] = await db.select({ id: schema.sdAutomationRules.id }).from(schema.sdAutomationRules).where(and(eq(schema.sdAutomationRules.id, rid), eq(schema.sdAutomationRules.serviceDeskId, g.desk.id))).limit(1)
  if (!rule) return notFound(c)
  const runs = await db.select({ issueKey: schema.issues.issueKey, outcome: schema.sdAutomationRuns.outcome, ranAt: schema.sdAutomationRuns.ranAt }).from(schema.sdAutomationRuns)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sdAutomationRuns.issueId)).where(eq(schema.sdAutomationRuns.ruleId, rid)).orderBy(desc(schema.sdAutomationRuns.ranAt)).limit(50)
  return c.json({ values: runs })
})

export default app
