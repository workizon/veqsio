import { issueVisibleSql } from '../security/issue-security'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { getDeskRole, isStaff, type DeskRole } from '../servicedesk/service'

/** Canned responses: reusable agent reply templates, scoped per service desk. */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403)
const isResponse = (v: unknown): v is Response => v instanceof Response

const cannedBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(10_000),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
}).strict()

const BASE = '/rest/servicedeskapi/servicedesk/:id/canned'

type Desk = typeof schema.serviceDesks.$inferSelect

/** Non-members and customers get 404 (no desk enumeration); writes need desk admin. */
async function guard(c: any, minRole: 'agent' | 'admin'): Promise<{ desk: Desk; role: DeskRole } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return notFound(c)
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  if (!desk) return notFound(c)
  const role = await getDeskRole(c.get('user'), desk)
  if (!isStaff(role)) return notFound(c)
  if (minRole === 'admin' && role !== 'admin') return forbidden(c)
  return { desk, role }
}

const cannedId = (c: any) => {
  const n = Number(c.req.param('cid'))
  return Number.isInteger(n) ? n : -1
}

/** Replace `{{customer.name}}` and `{{issue.key}}`; unknown placeholders stay untouched. Plain text, no escaping. */
export function renderCanned(body: string, vars: { 'customer.name': string; 'issue.key': string }): string {
  return body.replace(/\{\{\s*([a-zA-Z_.]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name as keyof typeof vars] : m)
}

app.get(BASE, requireAuth, async (c) => {
  const g = await guard(c, 'agent'); if (isResponse(g)) return g
  const rows = await db.select().from(schema.sdCannedResponses)
    .where(eq(schema.sdCannedResponses.serviceDeskId, g.desk.id))
    .orderBy(asc(schema.sdCannedResponses.sortOrder), asc(schema.sdCannedResponses.id))
  return c.json({ values: rows })
})

app.post(BASE, requireAuth, zValidator('json', cannedBody), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const [row] = await db.insert(schema.sdCannedResponses)
    .values({ ...c.req.valid('json'), serviceDeskId: g.desk.id, createdBy: c.get('user')!.id }).returning()
  return c.json(row, 201)
})

app.put(`${BASE}/:cid`, requireAuth, zValidator('json', cannedBody.partial()), async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const patch = c.req.valid('json')
  if (Object.keys(patch).length === 0) return c.json({ errorMessages: ['No fields to update'] }, 400)
  const [row] = await db.update(schema.sdCannedResponses).set(patch)
    .where(and(eq(schema.sdCannedResponses.id, cannedId(c)), eq(schema.sdCannedResponses.serviceDeskId, g.desk.id))).returning()
  return row ? c.json(row) : notFound(c)
})

app.delete(`${BASE}/:cid`, requireAuth, async (c) => {
  const g = await guard(c, 'admin'); if (isResponse(g)) return g
  const r = await db.delete(schema.sdCannedResponses)
    .where(and(eq(schema.sdCannedResponses.id, cannedId(c)), eq(schema.sdCannedResponses.serviceDeskId, g.desk.id)))
    .returning({ id: schema.sdCannedResponses.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

/** Render for a request of the same desk: `?issue=KEY`. Requests of other desks are 404. */
app.get(`${BASE}/:cid/render`, requireAuth, async (c) => {
  const g = await guard(c, 'agent'); if (isResponse(g)) return g
  const key = (c.req.query('issue') ?? '').trim()
  if (!key || key.length > 100) return c.json({ errorMessages: ['issue query parameter is required'] }, 400)
  const [canned] = await db.select().from(schema.sdCannedResponses)
    .where(and(eq(schema.sdCannedResponses.id, cannedId(c)), eq(schema.sdCannedResponses.serviceDeskId, g.desk.id))).limit(1)
  if (!canned) return notFound(c)
  const [row] = await db.select({ key: schema.issues.issueKey, customer: schema.users.displayName })
    .from(schema.serviceRequests)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .innerJoin(schema.users, eq(schema.users.id, schema.serviceRequests.customerId))
    .where(and(eq(schema.issues.issueKey, key), eq(schema.serviceRequests.serviceDeskId, g.desk.id), issueVisibleSql(c.get('user')!.id))).limit(1)
  if (!row) return notFound(c)
  return c.json({ title: canned.title, body: renderCanned(canned.body, { 'customer.name': row.customer, 'issue.key': row.key }) })
})

export default app
