import { onRequestCreated } from '../servicedesk/automation'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Context } from 'hono'
import { and, asc, eq, ilike, or } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { createIssue } from '../issues/service'
import { runRequestCreatedHooks } from '../modules/hooks'
import { getDeskRole, isStaff, type DeskRole } from '../servicedesk/service'
import { validateFieldValues, renderDescription, mapFieldValues, cleanText, type FieldDef } from '../servicedesk/form'
import { checkUserFields, resolveMappedFields } from '../servicedesk/form-resolve'
import { normalizeAddress } from '../servicedesk/inbound-email'
import { findUserByEmail, provisionUser } from '../servicedesk/customers'
import { DeskActionError, linkRequests, mergeRequests } from '../servicedesk/merge'
import { sendRequestMail } from '../servicedesk/outbound-mail'

/**
 * Agent-side service desk actions: customer notification settings, customer search, raising a request on behalf of a
 * customer, merging and linking requests. All of them are for desk agents and admins only (404 for everyone else,
 * so desk ids cannot be enumerated).
 */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403)
type Desk = typeof schema.serviceDesks.$inferSelect

const zj = <T extends z.ZodTypeAny>(s: T) => zValidator('json', s, (r, c: Context) => {
  if (!r.success) return c.json({ errorMessages: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message) }, 400)
})

async function staffGuard(c: any, minRole: 'agent' | 'admin' = 'agent'): Promise<{ desk: Desk; role: DeskRole } | Response> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return notFound(c)
  const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  if (!desk) return notFound(c)
  const role = await getDeskRole(c.get('user'), desk)
  if (!isStaff(role)) return notFound(c)
  if (minRole === 'admin' && role !== 'admin') return forbidden(c)
  return { desk, role }
}
const isResponse = (v: unknown): v is Response => v instanceof Response

/* ------------------------------------------------------------------ */
/*  Customer notification settings                                     */
/* ------------------------------------------------------------------ */

const notifBody = z.object({
  notifyCustomerComments: z.boolean().optional(),
  notifyCustomerStatus: z.boolean().optional(),
}).strict()

const notifView = (d: Desk) => ({ notifyCustomerComments: d.notifyCustomerComments, notifyCustomerStatus: d.notifyCustomerStatus })

app.get('/rest/servicedeskapi/servicedesk/:id/notification-settings', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  return c.json(notifView(g.desk))
})

app.put('/rest/servicedeskapi/servicedesk/:id/notification-settings', requireAuth, zj(notifBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  if (Object.keys(b).length === 0) return c.json(notifView(g.desk))
  const [row] = await db.update(schema.serviceDesks).set(b).where(eq(schema.serviceDesks.id, g.desk.id)).returning()
  return c.json(notifView(row))
})

/* ------------------------------------------------------------------ */
/*  Customer search (autocomplete)                                     */
/* ------------------------------------------------------------------ */

app.get('/rest/servicedeskapi/servicedesk/:id/customer-search', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  if (q.length < 1) return c.json({ values: [] })
  const term = `%${q.replace(/[%_\\]/g, '\\$&')}%`
  const rows = await db.select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email })
    .from(schema.serviceDeskCustomers).innerJoin(schema.users, eq(schema.users.id, schema.serviceDeskCustomers.userId))
    .where(and(
      eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id), eq(schema.users.active, true),
      or(ilike(schema.users.displayName, term), ilike(schema.users.email, term), ilike(schema.users.username, term)),
    )).orderBy(asc(schema.users.displayName)).limit(10)
  return c.json({ values: rows })
})

/* ------------------------------------------------------------------ */
/*  Raise a request on behalf of a customer                            */
/* ------------------------------------------------------------------ */

const behalfBody = z.object({
  customerId: z.number().int().positive().optional(),
  customerEmail: z.string().trim().max(320).email().optional(),
  customerName: z.string().trim().max(255).optional(),
  requestTypeId: z.number().int(),
  summary: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
  fieldValues: z.record(z.unknown()).default({}),
}).strict().refine((b) => (b.customerId === undefined) !== (b.customerEmail === undefined), 'Provide either customerId or customerEmail')

app.post('/rest/servicedeskapi/servicedesk/:id/request', requireAuth, zj(behalfBody), async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const agent = c.get('user')!
  const b = c.req.valid('json')
  if (!g.desk.enabled) return c.json({ errorMessages: ['This service desk is disabled'] }, 400)

  const [rt] = await db.select().from(schema.requestTypes).where(and(
    eq(schema.requestTypes.id, b.requestTypeId), eq(schema.requestTypes.serviceDeskId, g.desk.id), eq(schema.requestTypes.enabled, true),
  )).limit(1)
  if (!rt) return c.json({ errorMessages: ['Unknown request type'] }, 400)

  // Resolve (or create) the customer first-class, but only touch the database after the form validated.
  let customerId: number | null = null
  let email: string | null = null
  if (b.customerId !== undefined) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, b.customerId)).limit(1)
    if (!u || u.active === false) return c.json({ errorMessages: ['Customer not found'] }, 400)
    if ((await getDeskRole(u, g.desk)) === 'none') return c.json({ errorMessages: ['This user is not a customer of the service desk'] }, 400)
    customerId = u.id
  } else {
    email = normalizeAddress(b.customerEmail)
    if (!email) return c.json({ errorMessages: ['Invalid customer email address'] }, 400)
    const existing = await findUserByEmail(email)
    if (existing && existing.active === false) return c.json({ errorMessages: ['That account is deactivated'] }, 400)
    customerId = existing?.id ?? null
  }

  const defs = rt.fields as FieldDef[]
  const v = validateFieldValues(defs, b.fieldValues)
  if (!v.ok) return c.json({ errorMessages: v.errors }, 400)
  const userErrors = await checkUserFields(g.desk, defs, v.values)
  if (userErrors.length) return c.json({ errorMessages: userErrors }, 400)
  const mapped = mapFieldValues(defs, v.values)
  const summary = mapped.summary || (b.summary ? cleanText(b.summary).trim() : '')
  if (!summary) return c.json({ errorMessages: ['Summary is required'] }, 400)
  const resolved = await resolveMappedFields(g.desk, defs, mapped)

  if (customerId === null) {
    const created = await provisionUser(email!, b.customerName ?? '')
    if (!created) return c.json({ errorMessages: ['Could not create the customer'] }, 500)
    customerId = created.id
  }
  // Customers of this desk: an existing account entered by email becomes one (agents may enrol customers)
  await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: g.desk.id, userId: customerId }).onConflictDoNothing()

  const issue = await createIssue({
    projectId: g.desk.projectId,
    issueTypeId: rt.issueTypeId,
    priorityId: resolved.priorityId ?? rt.defaultPriorityId ?? undefined,
    summary,
    description: renderDescription(defs, v.values, b.description ? cleanText(b.description) : undefined),
    ...(resolved.labels.length ? { labels: resolved.labels } : {}),
    ...(resolved.componentIds.length ? { components: resolved.componentIds } : {}),
    ...(resolved.dueDate ? { dueDate: resolved.dueDate } : {}),
    ...(resolved.assigneeId ? { assigneeId: resolved.assigneeId } : {}),
    ...(resolved.customFields.length ? { customFields: resolved.customFields } : {}),
  }, customerId) // the customer is the reporter

  const [row] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1)
  await db.insert(schema.serviceRequests).values({
    issueId: row.id, serviceDeskId: g.desk.id, requestTypeId: rt.id, customerId, channel: 'agent', fieldValues: v.values,
  })
  // Activity note (internal, so it only shows to agents)
  await db.insert(schema.comments).values({
    issueId: row.id, authorId: agent.id, isInternal: true,
    body: `Raised on behalf of the customer by ${agent.displayName || agent.username}`,
  })
  await runRequestCreatedHooks({ issueId: row.id, issueKey: issue.key, deskId: g.desk.id, requestTypeId: rt.id, fieldValues: v.values })
  await onRequestCreated(row.id) // auto-categorisation rules
  try {
    await sendRequestMail({ issueId: row.id, kind: 'created', authorId: agent.id })
  } catch (e) {
    console.error('[servicedesk-agent] customer notice failed:', (e as Error)?.message)
  }
  return c.json({ key: issue.key, summary, customerId }, 201)
})

/* ------------------------------------------------------------------ */
/*  Merge and link                                                     */
/* ------------------------------------------------------------------ */

const keyRe = /^[A-Za-z][A-Za-z0-9_]*-\d{1,9}$/
const mergeBody = z.object({ targetKey: z.string().regex(keyRe), note: z.string().max(2000).optional() }).strict()
const linkBody = z.object({
  targetKey: z.string().regex(keyRe),
  linkTypeId: z.number().int().positive(),
  direction: z.enum(['outward', 'inward']).default('outward'),
}).strict()

const handleAction = (c: any, e: unknown) => {
  if (e instanceof DeskActionError) return c.json({ errorMessages: [e.message] }, e.status)
  throw e
}

app.post('/rest/servicedeskapi/servicedesk/:id/request/:key/merge', requireAuth, zj(mergeBody), async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const agent = c.get('user')!
  try {
    return c.json(await mergeRequests(g.desk, agent, String(c.req.param('key')), b.targetKey, b.note))
  } catch (e) { return handleAction(c, e) }
})

app.post('/rest/servicedeskapi/servicedesk/:id/request/:key/link', requireAuth, zj(linkBody), async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const b = c.req.valid('json')
  try {
    return c.json(await linkRequests(g.desk, String(c.req.param('key')), b.targetKey, b.linkTypeId, b.direction, c.get('user')!.id), 201)
  } catch (e) { return handleAction(c, e) }
})

export default app
