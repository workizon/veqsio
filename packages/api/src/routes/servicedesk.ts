import { onCustomerReply, onRequestCreated } from '../servicedesk/automation'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import type { Context } from 'hono'
import { createIssue } from '../issues/service'
import { applyTemplate, DESK_TEMPLATES } from '../servicedesk/templates'
import { runRequestCreatedHooks } from '../modules/hooks'
import { getRegisteredDeskTemplate, listAvailableDeskTemplates } from '../servicedesk/template-registry'
import {
  getDeskRole, isStaff, ensureCustomer, computeSlas, type DeskRole,
} from '../servicedesk/service'
import {
  FIELD_TYPES, MAPPING_TARGETS, FIELD_KEY_RE, isSafeFieldKey, validateFieldValues, renderDescription, validateFormDefinition,
  toPortalFields, hasMappedField, mapFieldValues, cleanText, type FieldDef,
} from '../servicedesk/form'
import { checkUserFields, resolveMappedFields } from '../servicedesk/form-resolve'
import { createProjectWithDefaults, isValidProjectKey } from '../projects/service'
import { checkGlobalPermission } from '../middleware/permissions'
import { csatDistribution, dailySeries, workloadByAgent, csatSummary, csatTrend, csatByGroup, needsFollowUp, kbArticleStats, searchStats, normalizeTerm, automationRunStats, type CsatRow, type ReportRow } from '../servicedesk/report'
import { toCsv } from '../audit/classify'
import { rankArticles } from '../servicedesk/kb-search'
import { portalRequestLimit, portalCommentLimit } from '../servicedesk/limits'
import { issueVisibleSql } from '../security/issue-security'
import { compileQueueJql, queueScope, queueOrder } from '../servicedesk/queue-jql'
import { buildJQLContext } from './search'

const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403)

type Desk = typeof schema.serviceDesks.$inferSelect

/* ------------------------------------------------------------------ */
/*  Validation schemas (strict: unknown keys are rejected)             */
/* ------------------------------------------------------------------ */

/** zod validation failures answer in the API's usual `{ errorMessages }` shape so the UI can show them. */
const zj = <T extends z.ZodTypeAny>(schema: T) => zValidator('json', schema, (r, c: Context) => {
  if (!r.success) return c.json({ errorMessages: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message) }, 400)
})

const fieldKey = z.string().regex(FIELD_KEY_RE).refine(isSafeFieldKey, 'Reserved field key')
const scalar = z.union([z.string().max(2000), z.number(), z.boolean()])

const fieldDef = z.object({
  key: fieldKey,
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(200)).max(100).optional(),
  helpText: z.string().max(2000).optional(),
  placeholder: z.string().max(200).optional(),
  internal: z.boolean().optional(),
  defaultValue: z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200)).max(100)]).optional(),
  validation: z.object({
    minLength: z.number().int().min(0).max(10_000).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    pattern: z.string().max(200).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }).strict().optional(),
  visibleWhen: z.object({
    field: fieldKey,
    op: z.enum(['equals', 'notEquals', 'in', 'filled']).optional(),
    value: z.union([scalar, z.array(scalar).max(100)]).optional(),
  }).strict().optional(),
  mapping: z.object({
    target: z.enum(MAPPING_TARGETS),
    customFieldId: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict()

const formFields = z.array(fieldDef).max(50).superRefine((fields, ctx) => {
  for (const msg of validateFormDefinition(fields as FieldDef[])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg })
})

const deskCreate = z.object({
  projectKey: z.string().min(1).max(50),
  /** true: create the backing Jira-style project with `projectKey` (needs the Create projects permission). */
  createProject: z.boolean().optional(),
  projectName: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}$/),
  description: z.string().max(5000).optional(),
  welcomeMessage: z.string().max(5000).optional(),
  publicSignup: z.boolean().optional(),
  // Built-in ids or the id of a template contributed by a module (checked in the handler).
  template: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/).default('none'),
}).strict()

const deskUpdate = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  welcomeMessage: z.string().max(5000).nullable().optional(),
  enabled: z.boolean().optional(),
  publicSignup: z.boolean().optional(),
  businessHours: z.object({
    utcOffsetMinutes: z.number().int().min(-720).max(840).optional(),
    days: z.record(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
      z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)]))),
  }).strict().nullable().optional(),
}).strict()

const requestTypeBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  helpText: z.string().max(5000).optional(),
  icon: z.string().max(50).optional(),
  groupName: z.string().max(100).nullable().optional(),
  issueTypeId: z.number().int(),
  defaultPriorityId: z.number().int().nullable().optional(),
  fields: formFields.default([]),
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
  /** Who may see the request type in the portal: everyone, or members of the listed customer organizations. */
  visibility: z.enum(['all', 'organizations']).optional(),
  organizationIds: z.array(z.number().int().positive()).max(200).optional(),
}).strict()

const portalSettingsBody = z.object({
  portalTitle: z.string().max(255).nullable().optional(),
  introduction: z.string().max(5000).nullable().optional(),
  groups: z.array(z.object({ name: z.string().trim().min(1).max(100), renamedFrom: z.string().max(100).optional() }).strict()).max(50).optional(),
  logoUrl: z.string().max(2000).regex(/^(https:\/\/|\/(?!\/))[^\s"'<>]+$/, 'Logo must be an https URL or a path on this site').nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour').nullable().optional(),
}).strict()

const orgBody = z.object({ name: z.string().trim().min(1).max(255) }).strict()
const reorderBody = z.object({ ids: z.array(z.number().int()).min(1).max(200) }).strict()

const queueBody = z.object({
  name: z.string().min(1).max(255),
  jql: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().optional(),
}).strict()

const kbBody = z.object({
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  labels: z.array(z.string().max(50)).max(20).default([]),
  published: z.boolean().default(false),
}).strict()

const userRef = z.object({ userId: z.number().int().optional(), email: z.string().email().max(320).optional(), role: z.enum(['agent', 'admin']).optional() }).strict()
  .refine((b) => (b.userId === undefined) !== (b.email === undefined), 'Provide either userId or email')
const customerRef = z.object({ userId: z.number().int().optional(), email: z.string().email().max(320).optional(), organizationId: z.number().int().positive().nullable().optional() }).strict()
  .refine((b) => (b.userId === undefined) !== (b.email === undefined), 'Provide either userId or email')

const requestCreate = z.object({
  requestTypeId: z.number().int(),
  summary: z.string().min(1).max(500).optional(), // optional when the form maps a field to the summary
  description: z.string().max(20_000).optional(),
  fieldValues: z.record(z.unknown()).default({}),
}).strict()

const commentBody = z.object({ body: z.string().min(1).max(20_000), internal: z.boolean().optional(), parentId: z.number().int().positive().optional() }).strict()
const csatBody = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).strict()

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function deskById(id: number): Promise<Desk | null> {
  if (!Number.isInteger(id)) return null
  const [d] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, id)).limit(1)
  return d ?? null
}

/** Load desk and the caller's role; staff-only guard returns a Response on failure. */
async function staffGuard(c: any, minRole: 'agent' | 'admin' = 'agent'): Promise<{ desk: Desk; role: DeskRole } | Response> {
  const desk = await deskById(Number(c.req.param('id')))
  if (!desk) return notFound(c)
  const role = await getDeskRole(c.get('user'), desk)
  // Non-members get 404 so desk ids cannot be enumerated.
  if (role === 'none' || role === 'customer') return notFound(c)
  if (minRole === 'admin' && role !== 'admin') return forbidden(c)
  return { desk, role }
}

const isResponse = (v: unknown): v is Response => v instanceof Response

function requestView(issue: any, req: any, slas?: any[]) {
  return {
    key: issue.issueKey,
    summary: issue.summary,
    statusId: issue.statusId,
    priorityId: issue.priorityId,
    assigneeId: issue.assigneeId,
    reporterId: issue.reporterId,
    requestTypeId: req.requestTypeId,
    channel: req.channel,
    created: issue.createdAt,
    updated: issue.updatedAt,
    resolved: issue.resolvedAt,
    csat: req.csatRating ? { rating: req.csatRating, comment: req.csatComment } : null,
    ...(slas ? { sla: slas } : {}),
  }
}

/* ------------------------------------------------------------------ */
/*  Desk administration                                                */
/* ------------------------------------------------------------------ */

app.get('/rest/servicedeskapi/servicedesk', requireAuth, async (c) => {
  const user = c.get('user')!
  const desks = await db.select().from(schema.serviceDesks).orderBy(asc(schema.serviceDesks.name))
  const projects = desks.length
    ? await db.select({ id: schema.projects.id, key: schema.projects.projectKey }).from(schema.projects).where(inArray(schema.projects.id, desks.map((d) => d.projectId)))
    : []
  const keyOf = new Map(projects.map((p) => [p.id, p.key]))
  const visible: any[] = []
  for (const d of desks) {
    const role = await getDeskRole(user, d)
    if (isStaff(role)) visible.push({ ...d, role, projectKey: keyOf.get(d.projectId) ?? null })
  }
  return c.json({ values: visible, size: visible.length })
})

/** Templates contributed by modules that can be used right now (licensed and enabled), for the creation wizard. */
app.get('/rest/servicedeskapi/desk-templates', requireAuth, async (c) => {
  return c.json({ values: await listAvailableDeskTemplates() })
})

app.post('/rest/servicedeskapi/servicedesk', requireAuth, zj(deskCreate), async (c) => {
  const user = c.get('user')!
  const body = c.req.valid('json')
  const registered = getRegisteredDeskTemplate(body.template)
  if (registered) {
    if (!(await registered.isAvailable())) return c.json({ errorMessages: [`This template requires a Veqsio Enterprise licence (${registered.feature}) and an enabled module.`], feature: registered.feature }, 402)
  } else if (body.template !== 'none' && !(DESK_TEMPLATES as readonly string[]).includes(body.template)) {
    return c.json({ errorMessages: ['Unknown template'] }, 400)
  }
  const [existing] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, body.projectKey)).limit(1)

  if (body.createProject) {
    if (existing) return c.json({ errorMessages: ['A project with this key already exists'] }, 409)
    if (!isValidProjectKey(body.projectKey)) return c.json({ errorMessages: ['Project key must be 2-10 upper-case letters or digits, starting with a letter'] }, 400)
    if (!(await checkGlobalPermission(user, 'CREATE_PROJECT'))) return forbidden(c)
  } else {
    if (!existing) return c.json({ errorMessages: ['Project not found'] }, 404)
    // Creating a desk requires administering the project (checked through a throwaway desk shape).
    const role = await getDeskRole(user, { projectId: existing.id, id: -1 } as Desk)
    if (role !== 'admin') return forbidden(c)
  }
  try {
    const desk = await db.transaction(async (tx) => {
      const project = existing ?? await createProjectWithDefaults(tx, {
        key: body.projectKey, name: body.projectName ?? body.name, description: body.description, leadId: user.id,
      })
      const [d] = await tx.insert(schema.serviceDesks).values({
        projectId: project.id, name: body.name, slug: body.slug, description: body.description,
        welcomeMessage: body.welcomeMessage, publicSignup: body.publicSignup ?? false,
      }).returning()
      if (!existing) await tx.insert(schema.serviceDeskAgents).values({ serviceDeskId: d.id, userId: user.id, role: 'admin' })
      if (body.template === 'none') {
        // Default: one queue; admins configure SLAs and request types.
        await tx.insert(schema.serviceQueues).values({ serviceDeskId: d.id, name: 'All open requests', sortOrder: 0 })
      } else {
        await applyTemplate(d.id, project.id, body.template, tx)
      }
      return { ...d, projectKey: project.projectKey }
    })
    return c.json(desk, 201)
  } catch (e: any) {
    if (String(e?.cause?.code ?? e?.code) === '23505') return c.json({ errorMessages: ['Desk already exists for project or slug is taken'] }, 409)
    throw e
  }
})

app.get('/rest/servicedeskapi/servicedesk/:id', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const [p] = await db.select({ key: schema.projects.projectKey, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, g.desk.projectId)).limit(1)
  return c.json({ ...g.desk, role: g.role, projectKey: p?.key ?? null, projectName: p?.name ?? null })
})

app.put('/rest/servicedeskapi/servicedesk/:id', requireAuth, zj(deskUpdate), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const [d] = await db.update(schema.serviceDesks).set(c.req.valid('json')).where(eq(schema.serviceDesks.id, g.desk.id)).returning()
  return c.json(d)
})

/* ---- request types ---- */

type RequestTypeRow = typeof schema.requestTypes.$inferSelect

async function settingsFor(ids: number[]) {
  const rows = ids.length ? await db.select().from(schema.requestTypeSettings).where(inArray(schema.requestTypeSettings.requestTypeId, ids)) : []
  return new Map(rows.map((r) => [r.requestTypeId, r]))
}

function typeView(rt: RequestTypeRow, st?: typeof schema.requestTypeSettings.$inferSelect, requestCount?: number) {
  return {
    ...rt,
    visibility: st?.visibility ?? 'all',
    organizationIds: (st?.organizationIds as number[] | undefined) ?? [],
    ...(requestCount !== undefined ? { requestCount } : {}),
  }
}

async function requestCounts(ids: number[]) {
  const rows = ids.length
    ? await db.select({ id: schema.serviceRequests.requestTypeId, n: sql<number>`count(*)::int` }).from(schema.serviceRequests)
        .where(inArray(schema.serviceRequests.requestTypeId, ids)).groupBy(schema.serviceRequests.requestTypeId)
    : []
  return new Map(rows.map((r) => [r.id, r.n]))
}

/** Foreign references of a request type payload; returns messages instead of letting the DB fail with a 500. */
async function checkTypeRefs(desk: Desk, b: Partial<z.infer<typeof requestTypeBody>>): Promise<string[]> {
  const errs: string[] = []
  if (b.issueTypeId !== undefined) {
    const [t] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(eq(schema.issueTypes.id, b.issueTypeId)).limit(1)
    if (!t) errs.push('Unknown issue type')
  }
  if (b.defaultPriorityId) {
    const [p] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(schema.priorities.id, b.defaultPriorityId)).limit(1)
    if (!p) errs.push('Unknown priority')
  }
  const cfIds = [...new Set((b.fields ?? []).map((f) => f.mapping?.customFieldId).filter((x): x is number => !!x))]
  if (cfIds.length) {
    const have = await db.select({ id: schema.customFields.id }).from(schema.customFields).where(inArray(schema.customFields.id, cfIds))
    if (have.length !== cfIds.length) errs.push('A field is mapped to an unknown custom field')
  }
  if (b.organizationIds?.length) {
    const orgs = await db.select({ id: schema.customerOrganizations.id }).from(schema.customerOrganizations)
      .where(and(eq(schema.customerOrganizations.serviceDeskId, desk.id), inArray(schema.customerOrganizations.id, b.organizationIds)))
    if (orgs.length !== new Set(b.organizationIds).size) errs.push('Unknown organization')
  }
  if (b.visibility === 'organizations' && b.organizationIds && b.organizationIds.length === 0) errs.push('Choose at least one organization')
  return errs
}

async function saveSettings(typeId: number, b: { visibility?: 'all' | 'organizations'; organizationIds?: number[] }) {
  if (b.visibility === undefined && b.organizationIds === undefined) return
  const visibility = b.visibility ?? (b.organizationIds?.length ? 'organizations' : undefined)
  await db.insert(schema.requestTypeSettings).values({
    requestTypeId: typeId, visibility: visibility ?? 'all', organizationIds: visibility === 'all' ? [] : (b.organizationIds ?? []),
  }).onConflictDoUpdate({
    target: schema.requestTypeSettings.requestTypeId,
    set: {
      ...(visibility ? { visibility } : {}),
      ...(visibility === 'all' ? { organizationIds: [] } : b.organizationIds ? { organizationIds: b.organizationIds } : {}),
      updatedAt: new Date(),
    },
  })
}

function splitTypeBody<T extends { visibility?: any; organizationIds?: any }>(b: T) {
  const { visibility, organizationIds, ...rt } = b
  return { rt, settings: { visibility, organizationIds } as { visibility?: 'all' | 'organizations'; organizationIds?: number[] } }
}

app.get('/rest/servicedeskapi/servicedesk/:id/requesttype', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const rows = await db.select().from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, g.desk.id)).orderBy(asc(schema.requestTypes.sortOrder), asc(schema.requestTypes.id))
  const ids = rows.map((r) => r.id)
  const [st, counts] = await Promise.all([settingsFor(ids), requestCounts(ids)])
  return c.json({ values: rows.map((r) => typeView(r, st.get(r.id), counts.get(r.id) ?? 0)) })
})

app.post('/rest/servicedeskapi/servicedesk/:id/requesttype', requireAuth, zj(requestTypeBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const body = c.req.valid('json')
  const errs = await checkTypeRefs(g.desk, body)
  if (errs.length) return c.json({ errorMessages: errs }, 400)
  const { rt, settings } = splitTypeBody(body)
  if (rt.sortOrder === undefined) {
    const [m] = await db.select({ m: sql<number>`coalesce(max(${schema.requestTypes.sortOrder}), -1)::int` }).from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, g.desk.id))
    rt.sortOrder = (m?.m ?? -1) + 1
  }
  const [r] = await db.insert(schema.requestTypes).values({ ...rt, serviceDeskId: g.desk.id }).returning()
  await saveSettings(r.id, settings)
  return c.json(typeView(r, (await settingsFor([r.id])).get(r.id), 0), 201)
})

app.post('/rest/servicedeskapi/servicedesk/:id/requesttype/reorder', requireAuth, zj(reorderBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const { ids } = c.req.valid('json')
  const own = await db.select({ id: schema.requestTypes.id }).from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, g.desk.id))
  const ownIds = new Set(own.map((r) => r.id))
  if (ids.some((i) => !ownIds.has(i)) || new Set(ids).size !== ids.length) return c.json({ errorMessages: ['Unknown or duplicate request type'] }, 400)
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(schema.requestTypes).set({ sortOrder: i }).where(eq(schema.requestTypes.id, id))
  })
  return c.body(null, 204)
})

app.get('/rest/servicedeskapi/servicedesk/:id/requesttype/:rtId', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const [r] = await db.select().from(schema.requestTypes)
    .where(and(eq(schema.requestTypes.id, Number(c.req.param('rtId'))), eq(schema.requestTypes.serviceDeskId, g.desk.id))).limit(1)
  if (!r) return notFound(c)
  return c.json(typeView(r, (await settingsFor([r.id])).get(r.id), (await requestCounts([r.id])).get(r.id) ?? 0))
})

app.put('/rest/servicedeskapi/servicedesk/:id/requesttype/:rtId', requireAuth, zj(requestTypeBody.partial()), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const body = c.req.valid('json')
  const errs = await checkTypeRefs(g.desk, body)
  if (errs.length) return c.json({ errorMessages: errs }, 400)
  const { rt, settings } = splitTypeBody(body)
  const where = and(eq(schema.requestTypes.id, Number(c.req.param('rtId'))), eq(schema.requestTypes.serviceDeskId, g.desk.id))
  const [r] = Object.keys(rt).length
    ? await db.update(schema.requestTypes).set(rt).where(where).returning()
    : await db.select().from(schema.requestTypes).where(where).limit(1)
  if (!r) return notFound(c)
  await saveSettings(r.id, settings)
  return c.json(typeView(r, (await settingsFor([r.id])).get(r.id)))
})

app.post('/rest/servicedeskapi/servicedesk/:id/requesttype/:rtId/duplicate', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const [src] = await db.select().from(schema.requestTypes)
    .where(and(eq(schema.requestTypes.id, Number(c.req.param('rtId'))), eq(schema.requestTypes.serviceDeskId, g.desk.id))).limit(1)
  if (!src) return notFound(c)
  const siblings = await db.select({ name: schema.requestTypes.name, sortOrder: schema.requestTypes.sortOrder }).from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, g.desk.id))
  const taken = new Set(siblings.map((s) => s.name.toLowerCase()))
  let name = `${src.name.slice(0, 240)} (copy)`
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${src.name.slice(0, 236)} (copy ${n})`
  const { id: _id, ...rest } = src
  const [copy] = await db.insert(schema.requestTypes).values({
    ...rest, name, enabled: false, sortOrder: Math.max(-1, ...siblings.map((s) => s.sortOrder)) + 1,
  }).returning()
  const st = (await settingsFor([src.id])).get(src.id)
  if (st) await db.insert(schema.requestTypeSettings).values({ requestTypeId: copy.id, visibility: st.visibility, organizationIds: st.organizationIds })
  return c.json(typeView(copy, (await settingsFor([copy.id])).get(copy.id), 0), 201)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/requesttype/:rtId', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const id = Number(c.req.param('rtId'))
  const [rt] = await db.select({ id: schema.requestTypes.id }).from(schema.requestTypes)
    .where(and(eq(schema.requestTypes.id, id), eq(schema.requestTypes.serviceDeskId, g.desk.id))).limit(1)
  if (!rt) return notFound(c)
  const requestCount = (await requestCounts([id])).get(id) ?? 0
  if (requestCount > 0) {
    return c.json({ errorMessages: [`This request type has ${requestCount} request${requestCount === 1 ? '' : 's'} and cannot be deleted. Disable it instead.`], requestCount }, 409)
  }
  await db.delete(schema.requestTypes).where(eq(schema.requestTypes.id, id))
  return c.body(null, 204)
})

/** Lookups the form builder needs (custom fields to map to, priorities, issue types, components, organizations). */
app.get('/rest/servicedeskapi/servicedesk/:id/formcontext', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const [customFields, priorities, issueTypes, components, organizations] = await Promise.all([
    db.select({ id: schema.customFields.id, name: schema.customFields.name, fieldType: schema.customFields.fieldType }).from(schema.customFields).orderBy(asc(schema.customFields.name)),
    db.select({ id: schema.priorities.id, name: schema.priorities.name }).from(schema.priorities).orderBy(asc(schema.priorities.id)),
    db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name, isSubtask: schema.issueTypes.isSubtask }).from(schema.issueTypes).orderBy(asc(schema.issueTypes.name)),
    db.select({ id: schema.components.id, name: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, g.desk.projectId)).orderBy(asc(schema.components.name)),
    db.select({ id: schema.customerOrganizations.id, name: schema.customerOrganizations.name }).from(schema.customerOrganizations).where(eq(schema.customerOrganizations.serviceDeskId, g.desk.id)).orderBy(asc(schema.customerOrganizations.name)),
  ])
  return c.json({ customFields, priorities, issueTypes: issueTypes.filter((t) => !t.isSubtask), components, organizations })
})

/* ---- portal settings ---- */

async function portalSettingsFor(desk: Desk) {
  const [st] = await db.select().from(schema.serviceDeskPortalSettings).where(eq(schema.serviceDeskPortalSettings.serviceDeskId, desk.id)).limit(1)
  const types = await db.select({ groupName: schema.requestTypes.groupName }).from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, desk.id))
  const configured = ((st?.groups as Array<{ name: string }> | undefined) ?? []).map((g) => g.name)
  // Groups used by request types but not yet ordered are appended so nothing is hidden.
  const extra = [...new Set(types.map((t) => t.groupName).filter((n): n is string => !!n))].filter((n) => !configured.includes(n))
  return {
    portalTitle: st?.portalTitle ?? null, introduction: st?.introduction ?? null,
    logoUrl: st?.logoUrl ?? null, accentColor: st?.accentColor ?? null,
    groups: [...configured, ...extra].map((name) => ({ name, requestTypeCount: types.filter((t) => t.groupName === name).length })),
  }
}

app.get('/rest/servicedeskapi/servicedesk/:id/portal-settings', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  return c.json({ ...(await portalSettingsFor(g.desk)), slug: g.desk.slug, enabled: g.desk.enabled, publicSignup: g.desk.publicSignup })
})

app.put('/rest/servicedeskapi/servicedesk/:id/portal-settings', requireAuth, zj(portalSettingsBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const { groups, ...rest } = c.req.valid('json')
  if (groups && new Set(groups.map((x) => x.name.toLowerCase())).size !== groups.length) return c.json({ errorMessages: ['Group names must be unique'] }, 400)
  await db.transaction(async (tx) => {
    for (const grp of groups ?? []) {
      if (grp.renamedFrom && grp.renamedFrom !== grp.name) {
        await tx.update(schema.requestTypes).set({ groupName: grp.name })
          .where(and(eq(schema.requestTypes.serviceDeskId, g.desk.id), eq(schema.requestTypes.groupName, grp.renamedFrom)))
      }
    }
    const values = { ...rest, ...(groups ? { groups: groups.map((x) => ({ name: x.name })) } : {}), updatedAt: new Date() }
    await tx.insert(schema.serviceDeskPortalSettings).values({ serviceDeskId: g.desk.id, ...values })
      .onConflictDoUpdate({ target: schema.serviceDeskPortalSettings.serviceDeskId, set: values })
  })
  return c.json(await portalSettingsFor(g.desk))
})

/* ---- queues ---- */

/** Validates queue JQL with the real parser; answers 400 with the parser's message and position. */
async function queueJqlError(c: any, jql: string | null | undefined): Promise<Response | null> {
  if (!jql || !jql.trim()) return null
  const r = compileQueueJql(jql, await buildJQLContext(c.get('user')))
  if (r.ok) return null
  return c.json({ errorMessages: [r.message], errors: { jql: r.message }, jqlError: { message: r.message, position: r.pos } }, 400)
}

/** Queues of a desk; `?counts=true` adds the number of matching requests per queue (one cheap COUNT each). */
app.get('/rest/servicedeskapi/servicedesk/:id/queue', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const queues = await db.select().from(schema.serviceQueues).where(eq(schema.serviceQueues.serviceDeskId, g.desk.id)).orderBy(asc(schema.serviceQueues.sortOrder))
  if (c.req.query('counts') !== 'true') return c.json({ values: queues })
  const ctx = await buildJQLContext(c.get('user'))
  const values = await Promise.all(queues.map(async (q) => {
    const compiled = compileQueueJql(q.jql, ctx)
    if (!compiled.ok) return { ...q, count: null, error: compiled.message }
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.serviceRequests)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
      .where(and(eq(schema.serviceRequests.serviceDeskId, g.desk.id), queueScope(g.desk.projectId, compiled, c.get('user')!.id)))
    return { ...q, count: row?.n ?? 0 }
  }))
  return c.json({ values })
})

app.post('/rest/servicedeskapi/servicedesk/:id/queue', requireAuth, zj(queueBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const body = c.req.valid('json')
  const bad = await queueJqlError(c, body.jql); if (bad) return bad
  const [q] = await db.insert(schema.serviceQueues).values({ ...body, serviceDeskId: g.desk.id }).returning()
  return c.json(q, 201)
})

app.put('/rest/servicedeskapi/servicedesk/:id/queue/:qid', requireAuth, zj(queueBody.partial()), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const body = c.req.valid('json')
  const bad = await queueJqlError(c, body.jql); if (bad) return bad
  const [q] = await db.update(schema.serviceQueues).set(body)
    .where(and(eq(schema.serviceQueues.id, Number(c.req.param('qid'))), eq(schema.serviceQueues.serviceDeskId, g.desk.id))).returning()
  return q ? c.json(q) : notFound(c)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/queue/:qid', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const r = await db.delete(schema.serviceQueues)
    .where(and(eq(schema.serviceQueues.id, Number(c.req.param('qid'))), eq(schema.serviceQueues.serviceDeskId, g.desk.id))).returning({ id: schema.serviceQueues.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

/** Requests of a desk (optionally narrowed by queue / status / free text), with SLA timers. */
app.get('/rest/servicedeskapi/servicedesk/:id/request', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const q = c.req.query()
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const offset = Math.max(Number(q.start) || 0, 0)

  const conds = [eq(schema.serviceRequests.serviceDeskId, g.desk.id), issueVisibleSql(c.get('user')!.id)]
  if (q.status) conds.push(eq(schema.issues.statusId, Number(q.status)))
  if (q.assignee === 'me') conds.push(eq(schema.issues.assigneeId, c.get('user')!.id))
  if (q.assignee === 'unassigned') conds.push(sql`${schema.issues.assigneeId} is null`)
  if (q.open === 'true') conds.push(sql`${schema.issues.resolutionId} is null`)
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`
    conds.push(or(ilike(schema.issues.summary, term), ilike(schema.issues.issueKey, term))!)
  }
  // A queue is ordinary JQL run by the real engine, always AND-ed with the desk's project (and this desk's requests).
  let order: any[] = [desc(schema.issues.createdAt), desc(schema.issues.id)]
  if (q.queue) {
    const [queue] = await db.select().from(schema.serviceQueues)
      .where(and(eq(schema.serviceQueues.id, Number(q.queue)), eq(schema.serviceQueues.serviceDeskId, g.desk.id))).limit(1)
    if (!queue) return notFound(c)
    const compiled = compileQueueJql(queue.jql, await buildJQLContext(c.get('user')))
    if (!compiled.ok) return c.json({ errorMessages: [`Queue JQL is invalid: ${compiled.message}`], jqlError: { message: compiled.message, position: compiled.pos } }, 400)
    conds.push(queueScope(g.desk.projectId, compiled, c.get('user')!.id))
    order = queueOrder(compiled)
  }

  const rows = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(...conds)).orderBy(...order).limit(limit).offset(offset)
  const [totalRow] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.serviceRequests)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId)).where(and(...conds))

  const slas = await computeSlas(g.desk, rows.map((r) => r.issue.id))
  return c.json({ start: offset, limit, total: totalRow?.n ?? 0, values: rows.map((r) => requestView(r.issue, r.req, slas.get(r.issue.id) ?? [])) })
})

/* ---- SLAs and calendars live in servicedesk-sla.ts ---- */

/* ---- agents / customers / organizations ---- */

/** Resolve a `{ userId } | { email }` reference to a user id (404 handled by callers on null). */
async function resolveUserRef(b: { userId?: number; email?: string }): Promise<number | null> {
  const [u] = b.userId !== undefined
    ? await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, b.userId)).limit(1)
    : await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${b.email!.toLowerCase()}`).limit(1)
  return u?.id ?? null
}

async function orgOfDesk(desk: Desk, orgId: number) {
  const [o] = await db.select().from(schema.customerOrganizations)
    .where(and(eq(schema.customerOrganizations.id, orgId), eq(schema.customerOrganizations.serviceDeskId, desk.id))).limit(1)
  return o ?? null
}

app.get('/rest/servicedeskapi/servicedesk/:id/agent', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const rows = await db.select({ userId: schema.users.id, displayName: schema.users.displayName, email: schema.users.email, role: schema.serviceDeskAgents.role })
    .from(schema.serviceDeskAgents).innerJoin(schema.users, eq(schema.users.id, schema.serviceDeskAgents.userId))
    .where(eq(schema.serviceDeskAgents.serviceDeskId, g.desk.id))
  return c.json({ values: rows })
})

app.post('/rest/servicedeskapi/servicedesk/:id/agent', requireAuth, zj(userRef), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const userId = await resolveUserRef(b)
  if (userId === null) return c.json({ errorMessages: ['User not found'] }, 404)
  await db.insert(schema.serviceDeskAgents).values({ serviceDeskId: g.desk.id, userId, role: b.role ?? 'agent' })
    .onConflictDoUpdate({ target: [schema.serviceDeskAgents.serviceDeskId, schema.serviceDeskAgents.userId], set: { role: b.role ?? 'agent' } })
  return c.body(null, 204)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/agent/:userId', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  await db.delete(schema.serviceDeskAgents)
    .where(and(eq(schema.serviceDeskAgents.serviceDeskId, g.desk.id), eq(schema.serviceDeskAgents.userId, Number(c.req.param('userId')))))
  return c.body(null, 204)
})

app.get('/rest/servicedeskapi/servicedesk/:id/customer', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const rows = await db.select({
    userId: schema.users.id, displayName: schema.users.displayName, email: schema.users.email,
    organizationId: schema.serviceDeskCustomers.organizationId, organization: schema.customerOrganizations.name,
  }).from(schema.serviceDeskCustomers).innerJoin(schema.users, eq(schema.users.id, schema.serviceDeskCustomers.userId))
    .leftJoin(schema.customerOrganizations, eq(schema.customerOrganizations.id, schema.serviceDeskCustomers.organizationId))
    .where(eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id))
  return c.json({ values: rows })
})

app.post('/rest/servicedeskapi/servicedesk/:id/customer', requireAuth, zj(customerRef), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const b = c.req.valid('json')
  const userId = await resolveUserRef(b)
  if (userId === null) return c.json({ errorMessages: ['User not found'] }, 404)
  if (b.organizationId && !(await orgOfDesk(g.desk, b.organizationId))) return c.json({ errorMessages: ['Unknown organization'] }, 400)
  await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: g.desk.id, userId, organizationId: b.organizationId ?? null })
    .onConflictDoUpdate({
      target: [schema.serviceDeskCustomers.serviceDeskId, schema.serviceDeskCustomers.userId],
      set: b.organizationId !== undefined ? { organizationId: b.organizationId } : { serviceDeskId: g.desk.id },
    })
  return c.body(null, 204)
})

/** Move a customer into / out of an organization. */
app.put('/rest/servicedeskapi/servicedesk/:id/customer/:userId', requireAuth, zj(z.object({ organizationId: z.number().int().positive().nullable() }).strict()), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const { organizationId } = c.req.valid('json')
  if (organizationId && !(await orgOfDesk(g.desk, organizationId))) return c.json({ errorMessages: ['Unknown organization'] }, 400)
  const r = await db.update(schema.serviceDeskCustomers).set({ organizationId })
    .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id), eq(schema.serviceDeskCustomers.userId, Number(c.req.param('userId'))))).returning({ id: schema.serviceDeskCustomers.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/customer/:userId', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  await db.delete(schema.serviceDeskCustomers)
    .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id), eq(schema.serviceDeskCustomers.userId, Number(c.req.param('userId')))))
  return c.body(null, 204)
})

app.get('/rest/servicedeskapi/servicedesk/:id/organization', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const orgs = await db.select().from(schema.customerOrganizations).where(eq(schema.customerOrganizations.serviceDeskId, g.desk.id)).orderBy(asc(schema.customerOrganizations.name))
  const counts = await db.select({ id: schema.serviceDeskCustomers.organizationId, n: sql<number>`count(*)::int` }).from(schema.serviceDeskCustomers)
    .where(eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id)).groupBy(schema.serviceDeskCustomers.organizationId)
  const n = new Map(counts.map((x) => [x.id, x.n]))
  return c.json({ values: orgs.map((o) => ({ ...o, customerCount: n.get(o.id) ?? 0 })) })
})

app.post('/rest/servicedeskapi/servicedesk/:id/organization', requireAuth, zj(orgBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const { name } = c.req.valid('json')
  const [dup] = await db.select({ id: schema.customerOrganizations.id }).from(schema.customerOrganizations)
    .where(and(eq(schema.customerOrganizations.serviceDeskId, g.desk.id), sql`lower(${schema.customerOrganizations.name}) = ${name.toLowerCase()}`)).limit(1)
  if (dup) return c.json({ errorMessages: ['An organization with this name already exists'] }, 409)
  const [o] = await db.insert(schema.customerOrganizations).values({ serviceDeskId: g.desk.id, name }).returning()
  return c.json({ ...o, customerCount: 0 }, 201)
})

app.put('/rest/servicedeskapi/servicedesk/:id/organization/:orgId', requireAuth, zj(orgBody), async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const [o] = await db.update(schema.customerOrganizations).set({ name: c.req.valid('json').name })
    .where(and(eq(schema.customerOrganizations.id, Number(c.req.param('orgId'))), eq(schema.customerOrganizations.serviceDeskId, g.desk.id))).returning()
  return o ? c.json(o) : notFound(c)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/organization/:orgId', requireAuth, async (c) => {
  const g = await staffGuard(c, 'admin'); if (isResponse(g)) return g
  const orgId = Number(c.req.param('orgId'))
  if (!(await orgOfDesk(g.desk, orgId))) return notFound(c)
  await db.transaction(async (tx) => {
    await tx.update(schema.serviceDeskCustomers).set({ organizationId: null })
      .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, g.desk.id), eq(schema.serviceDeskCustomers.organizationId, orgId)))
    await tx.delete(schema.customerOrganizations).where(eq(schema.customerOrganizations.id, orgId))
  })
  return c.body(null, 204)
})

/* ---- knowledge base (staff) ---- */

app.get('/rest/servicedeskapi/servicedesk/:id/kb', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const rows = await db.select().from(schema.kbArticles).where(eq(schema.kbArticles.serviceDeskId, g.desk.id)).orderBy(desc(schema.kbArticles.updatedAt))
  return c.json({ values: rows })
})

app.post('/rest/servicedeskapi/servicedesk/:id/kb', requireAuth, zj(kbBody), async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const [a] = await db.insert(schema.kbArticles).values({ ...c.req.valid('json'), serviceDeskId: g.desk.id, authorId: c.get('user')!.id }).returning()
  return c.json(a, 201)
})

app.put('/rest/servicedeskapi/servicedesk/:id/kb/:aid', requireAuth, zj(kbBody.partial()), async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const [a] = await db.update(schema.kbArticles).set({ ...c.req.valid('json'), updatedAt: new Date() })
    .where(and(eq(schema.kbArticles.id, Number(c.req.param('aid'))), eq(schema.kbArticles.serviceDeskId, g.desk.id))).returning()
  return a ? c.json(a) : notFound(c)
})

app.delete('/rest/servicedeskapi/servicedesk/:id/kb/:aid', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const r = await db.delete(schema.kbArticles)
    .where(and(eq(schema.kbArticles.id, Number(c.req.param('aid'))), eq(schema.kbArticles.serviceDeskId, g.desk.id))).returning({ id: schema.kbArticles.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

/* ---- reports ---- */

app.get('/rest/servicedeskapi/servicedesk/:id/report', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const rows = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.serviceRequests.serviceDeskId, g.desk.id), issueVisibleSql(c.get('user')!.id))).orderBy(desc(schema.issues.createdAt)).limit(2000)

  const slas = await computeSlas(g.desk, rows.map((r) => r.issue.id))
  const perSla = new Map<number, { name: string; met: number; breached: number; running: number }>()
  for (const list of slas.values()) {
    for (const s of list) {
      const e = perSla.get(s.slaId) ?? { name: s.name, met: 0, breached: 0, running: 0 }
      if (s.status === 'met') e.met++
      else if (s.status === 'breached') e.breached++
      else e.running++
      perSla.set(s.slaId, e)
    }
  }
  const rated = rows.filter((r) => r.req.csatRating)
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
  const assigneeIds = [...new Set(rows.map((r) => r.issue.assigneeId).filter((x): x is number => x != null))]
  const names = new Map<number, string>()
  if (assigneeIds.length) {
    const us = await db.select({ id: schema.users.id, name: schema.users.displayName, username: schema.users.username })
      .from(schema.users).where(inArray(schema.users.id, assigneeIds))
    for (const u of us) names.set(u.id, u.name || u.username)
  }
  const reportRows: ReportRow[] = rows.map((r) => ({
    createdAt: r.issue.createdAt ?? new Date(0), resolvedAt: r.issue.resolvedAt,
    assigneeId: r.issue.assigneeId, assigneeName: r.issue.assigneeId != null ? names.get(r.issue.assigneeId) ?? null : null,
    csatRating: r.req.csatRating,
  }))
  return c.json({
    days,
    daily: dailySeries(reportRows, days),
    workload: workloadByAgent(reportRows, new Date(Date.now() - days * 86_400_000)),
    csatDistribution: csatDistribution(reportRows),
    total: rows.length,
    open: rows.filter((r) => !r.issue.resolutionId).length,
    resolved: rows.filter((r) => r.issue.resolutionId).length,
    csat: { responses: rated.length, average: rated.length ? rated.reduce((a, r) => a + (r.req.csatRating ?? 0), 0) / rated.length : null },
    sla: [...perSla.entries()].map(([slaId, v]) => ({
      slaId, ...v, compliance: v.met + v.breached ? v.met / (v.met + v.breached) : null,
    })),
  })
})

// CSAT report: summary, weekly trend, by agent and by request type, and the follow-up queue of poor ratings.
app.get('/rest/servicedeskapi/servicedesk/:id/csat', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const days = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 730)
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db.select({ issue: schema.issues, req: schema.serviceRequests, type: schema.requestTypes.name, customer: schema.users.displayName, customerEmail: schema.users.email })
    .from(schema.serviceRequests)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .leftJoin(schema.requestTypes, eq(schema.requestTypes.id, schema.serviceRequests.requestTypeId))
    .leftJoin(schema.users, eq(schema.users.id, schema.serviceRequests.customerId))
    .where(and(eq(schema.serviceRequests.serviceDeskId, g.desk.id), issueVisibleSql(c.get('user')!.id), or(gte(schema.serviceRequests.csatAt, since), gte(schema.issues.resolvedAt, since))))
    .limit(5000)
  const assigneeIds = [...new Set(rows.map((r) => r.issue.assigneeId).filter((x): x is number => x != null))]
  const names = new Map<number, string>()
  if (assigneeIds.length) for (const u of await db.select({ id: schema.users.id, name: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, assigneeIds))) names.set(u.id, u.name || u.username)
  const base = (r: (typeof rows)[number]) => ({ rating: r.req.csatRating, ratedAt: r.req.csatAt, resolved: !!r.issue.resolutionId })
  const byAgent: CsatRow[] = rows.map((r) => ({ ...base(r), groupKey: r.issue.assigneeId != null ? String(r.issue.assigneeId) : null, groupName: r.issue.assigneeId != null ? names.get(r.issue.assigneeId) ?? null : null }))
  const byType: CsatRow[] = rows.map((r) => ({ ...base(r), groupKey: r.req.requestTypeId != null ? String(r.req.requestTypeId) : null, groupName: r.type ?? null }))
  const inPeriod = byAgent.filter((r) => !r.ratedAt || r.ratedAt >= since)
  const followUps = rows.filter((r) => needsFollowUp(r.req.csatRating, r.req.csatHandledAt) && r.req.csatAt && r.req.csatAt >= since)
    .sort((a, b) => a.req.csatAt!.getTime() - b.req.csatAt!.getTime()).slice(0, 100)
    .map((r) => ({ key: r.issue.issueKey, summary: r.issue.summary, rating: r.req.csatRating, comment: r.req.csatComment, ratedAt: r.req.csatAt, customer: r.customer, assignee: r.issue.assigneeId != null ? names.get(r.issue.assigneeId) ?? null : null }))
  return c.json({
    days,
    summary: csatSummary(inPeriod),
    distribution: csatDistribution(rows.map((r) => ({ createdAt: r.issue.createdAt ?? new Date(0), resolvedAt: r.issue.resolvedAt, assigneeId: r.issue.assigneeId, assigneeName: null, csatRating: r.req.csatAt && r.req.csatAt >= since ? r.req.csatRating : null }))),
    trend: csatTrend(byAgent, since, new Date()),
    byAgent: csatByGroup(inPeriod),
    byRequestType: csatByGroup(byType.filter((r) => !r.ratedAt || r.ratedAt >= since)),
    followUps,
  })
})

// An agent marks a poor rating as dealt with (it leaves the follow-up queue).
app.post('/rest/servicedeskapi/servicedesk/:id/csat/:key/handled', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const [row] = await db.select({ id: schema.serviceRequests.id }).from(schema.serviceRequests)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.issues.issueKey, c.req.param('key').toUpperCase()), eq(schema.serviceRequests.serviceDeskId, g.desk.id), issueVisibleSql(c.get('user')!.id))).limit(1)
  if (!row) return notFound(c)
  await db.update(schema.serviceRequests).set({ csatHandledAt: new Date(), csatHandledBy: c.get('user')!.id }).where(eq(schema.serviceRequests.id, row.id))
  return c.json({})
})

// Knowledge base usage: article views and votes, never-viewed articles, popular searches and searches that found nothing.
app.get('/rest/servicedeskapi/servicedesk/:id/kb-report', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86_400_000)
  const articles = await db.select({ id: schema.kbArticles.id, title: schema.kbArticles.title, published: schema.kbArticles.published, views: schema.kbArticles.views, helpful: schema.kbArticles.helpful, notHelpful: schema.kbArticles.notHelpful, updatedAt: schema.kbArticles.updatedAt })
    .from(schema.kbArticles).where(eq(schema.kbArticles.serviceDeskId, g.desk.id)).limit(2000)
  const searches = await db.select({ term: schema.kbSearchLog.term, results: schema.kbSearchLog.results }).from(schema.kbSearchLog)
    .where(and(eq(schema.kbSearchLog.serviceDeskId, g.desk.id), gte(schema.kbSearchLog.createdAt, since))).limit(20000)
  const stats = kbArticleStats(articles)
  const result = { days, totals: { articles: articles.length, published: articles.filter((a) => a.published).length, views: articles.reduce((n, a) => n + a.views, 0), neverViewed: articles.filter((a) => a.published && a.views === 0).length, searches: searches.length }, articles: stats, ...searchStats(searches) }
  if (c.req.query('format') === 'csv') {
    c.header('Content-Type', 'text/csv; charset=utf-8'); c.header('Content-Disposition', 'attachment; filename="kb-articles.csv"')
    return c.body(toCsv(['Article', 'Published', 'Views', 'Helpful', 'Not helpful', 'Helpful %', 'Updated'], stats.map((a) => [a.title, a.published ? 'yes' : 'no', a.views, a.helpful, a.notHelpful, a.helpfulPct === null ? '' : Math.round(a.helpfulPct), a.updatedAt])))
  }
  return c.json(result)
})

// What the automation rules did: runs per rule, failures and the latest failure text.
app.get('/rest/servicedeskapi/servicedesk/:id/automation-report', requireAuth, async (c) => {
  const g = await staffGuard(c); if (isResponse(g)) return g
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86_400_000)
  const rules = await db.select({ id: schema.sdAutomationRules.id, name: schema.sdAutomationRules.name, trigger: schema.sdAutomationRules.trigger, action: schema.sdAutomationRules.action, enabled: schema.sdAutomationRules.enabled })
    .from(schema.sdAutomationRules).where(eq(schema.sdAutomationRules.serviceDeskId, g.desk.id))
  const runs = rules.length ? await db.select({ ruleId: schema.sdAutomationRuns.ruleId, outcome: schema.sdAutomationRuns.outcome, ranAt: schema.sdAutomationRuns.ranAt }).from(schema.sdAutomationRuns)
    .where(and(inArray(schema.sdAutomationRuns.ruleId, rules.map((r) => r.id)), gte(schema.sdAutomationRuns.ranAt, since))).limit(50000) : []
  const stats = automationRunStats(runs)
  const values = rules.map((r) => ({ ...r, ...(stats.find((s) => s.ruleId === r.id) ?? { runs: 0, failures: 0, lastRunAt: null, lastFailure: null }) }))
  if (c.req.query('format') === 'csv') {
    c.header('Content-Type', 'text/csv; charset=utf-8'); c.header('Content-Disposition', 'attachment; filename="automation-runs.csv"')
    return c.body(toCsv(['Rule', 'Trigger', 'Action', 'Enabled', 'Runs', 'Failures', 'Last run', 'Last failure'], values.map((v) => [v.name, v.trigger, v.action, v.enabled ? 'yes' : 'no', v.runs, v.failures, v.lastRunAt, v.lastFailure])))
  }
  return c.json({ days, values })
})

/* ------------------------------------------------------------------ */
/*  Customer portal                                                    */
/* ------------------------------------------------------------------ */

async function portalGuard(c: any): Promise<{ desk: Desk } | Response> {
  const [desk] = await db.select().from(schema.serviceDesks)
    .where(and(eq(schema.serviceDesks.slug, c.req.param('slug')), eq(schema.serviceDesks.enabled, true))).limit(1)
  if (!desk) return notFound(c)
  if (!(await ensureCustomer(c.get('user'), desk))) return notFound(c)
  return { desk }
}

/** Request types the caller may see: everyone for visibility "all", otherwise customers of the listed organizations (staff see all). */
async function visibleRequestTypes(c: any, desk: Desk, enabledOnly = true) {
  const types = await db.select().from(schema.requestTypes)
    .where(and(eq(schema.requestTypes.serviceDeskId, desk.id), ...(enabledOnly ? [eq(schema.requestTypes.enabled, true)] : [])))
    .orderBy(asc(schema.requestTypes.sortOrder), asc(schema.requestTypes.id))
  const st = await settingsFor(types.map((t) => t.id))
  const user = c.get('user')!
  const staff = isStaff(await getDeskRole(user, desk))
  const [cust] = await db.select({ org: schema.serviceDeskCustomers.organizationId }).from(schema.serviceDeskCustomers)
    .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, desk.id), eq(schema.serviceDeskCustomers.userId, user.id))).limit(1)
  return types.filter((t) => {
    const s = st.get(t.id)
    if (!s || s.visibility === 'all' || staff) return true
    return cust?.org != null && (s.organizationIds as number[]).includes(cust.org)
  })
}

app.get('/rest/servicedeskapi/portal/:slug', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const [types, ps] = await Promise.all([visibleRequestTypes(c, g.desk), portalSettingsFor(g.desk)])
  return c.json({
    name: g.desk.name, slug: g.desk.slug, description: g.desk.description, welcomeMessage: g.desk.welcomeMessage,
    portalTitle: ps.portalTitle, introduction: ps.introduction, logoUrl: ps.logoUrl, accentColor: ps.accentColor,
    groups: ps.groups.map((x) => x.name),
    requestTypes: types.map((t) => {
      const defs = t.fields as FieldDef[]
      return {
        id: t.id, name: t.name, description: t.description, helpText: t.helpText, icon: t.icon, groupName: t.groupName,
        // Internal-only fields and all issue mapping configuration stay server side.
        fields: toPortalFields(defs),
        summaryField: hasMappedField(defs, 'summary'), descriptionField: hasMappedField(defs, 'description'),
      }
    }),
  })
})

app.get('/rest/servicedeskapi/portal/:slug/kb', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const q = (c.req.query('q') ?? '').trim().slice(0, 300)
  let rows
  if (q) {
    // Word-based ranking (a whole question such as "I cannot reset my VPN password" finds the article), best match first,
    // with a snippet around the match so the customer can often read the answer without opening the article.
    const candidates = await db.select({ id: schema.kbArticles.id, title: schema.kbArticles.title, body: schema.kbArticles.body, labels: schema.kbArticles.labels, helpful: schema.kbArticles.helpful, views: schema.kbArticles.views })
      .from(schema.kbArticles).where(and(eq(schema.kbArticles.serviceDeskId, g.desk.id), eq(schema.kbArticles.published, true))).limit(500)
    rows = rankArticles(candidates, q, 10).map(({ id, title, labels, excerpt }) => ({ id, title, labels, excerpt }))
  } else {
    rows = await db.select({
      id: schema.kbArticles.id, title: schema.kbArticles.title, labels: schema.kbArticles.labels,
      excerpt: sql<string>`left(${schema.kbArticles.body}, 240)`,
    }).from(schema.kbArticles).where(and(eq(schema.kbArticles.serviceDeskId, g.desk.id), eq(schema.kbArticles.published, true))).orderBy(desc(schema.kbArticles.helpful), desc(schema.kbArticles.views)).limit(10)
  }
  // What customers look for (no user stored): the report shows searches that found nothing as content gaps.
  if (q.length >= 2) void db.insert(schema.kbSearchLog).values({ serviceDeskId: g.desk.id, term: normalizeTerm(q), results: rows.length }).catch(() => {})
  return c.json({ values: rows })
})

app.get('/rest/servicedeskapi/portal/:slug/kb/:aid', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const [a] = await db.update(schema.kbArticles).set({ views: sql`${schema.kbArticles.views} + 1` })
    .where(and(eq(schema.kbArticles.id, Number(c.req.param('aid'))), eq(schema.kbArticles.serviceDeskId, g.desk.id), eq(schema.kbArticles.published, true)))
    .returning({ id: schema.kbArticles.id, title: schema.kbArticles.title, body: schema.kbArticles.body, labels: schema.kbArticles.labels })
  return a ? c.json(a) : notFound(c)
})

app.post('/rest/servicedeskapi/portal/:slug/kb/:aid/helpful', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const r = await db.update(schema.kbArticles).set({ helpful: sql`${schema.kbArticles.helpful} + 1` })
    .where(and(eq(schema.kbArticles.id, Number(c.req.param('aid'))), eq(schema.kbArticles.serviceDeskId, g.desk.id), eq(schema.kbArticles.published, true)))
    .returning({ id: schema.kbArticles.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

app.post('/rest/servicedeskapi/portal/:slug/kb/:aid/not-helpful', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const r = await db.update(schema.kbArticles).set({ notHelpful: sql`${schema.kbArticles.notHelpful} + 1` })
    .where(and(eq(schema.kbArticles.id, Number(c.req.param('aid'))), eq(schema.kbArticles.serviceDeskId, g.desk.id), eq(schema.kbArticles.published, true)))
    .returning({ id: schema.kbArticles.id })
  return r.length ? c.body(null, 204) : notFound(c)
})

app.post('/rest/servicedeskapi/portal/:slug/request', requireAuth, zj(requestCreate), async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  { const lim = await portalRequestLimit(c, g.desk); if (lim) return lim }
  const user = c.get('user')!
  const body = c.req.valid('json')
  const rt = (await visibleRequestTypes(c, g.desk)).find((t) => t.id === body.requestTypeId)
  if (!rt) return c.json({ errorMessages: ['Unknown request type'] }, 400)

  const defs = rt.fields as FieldDef[]
  const v = validateFieldValues(defs, body.fieldValues)
  if (!v.ok) return c.json({ errorMessages: v.errors }, 400)
  const userErrors = await checkUserFields(g.desk, defs, v.values)
  if (userErrors.length) return c.json({ errorMessages: userErrors }, 400)

  const mapped = mapFieldValues(defs, v.values)
  const summary = mapped.summary || (body.summary ? cleanText(body.summary).trim() : '')
  if (!summary) return c.json({ errorMessages: ['Summary is required'] }, 400)
  const resolved = await resolveMappedFields(g.desk, defs, mapped)

  const issue = await createIssue({
    projectId: g.desk.projectId,
    issueTypeId: rt.issueTypeId,
    priorityId: resolved.priorityId ?? rt.defaultPriorityId ?? undefined,
    summary,
    description: renderDescription(defs, v.values, body.description ? cleanText(body.description) : undefined),
    ...(resolved.labels.length ? { labels: resolved.labels } : {}),
    ...(resolved.componentIds.length ? { components: resolved.componentIds } : {}),
    ...(resolved.dueDate ? { dueDate: resolved.dueDate } : {}),
    ...(resolved.assigneeId ? { assigneeId: resolved.assigneeId } : {}),
    ...(resolved.customFields.length ? { customFields: resolved.customFields } : {}),
  }, user.id)

  const [row] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1)
  await db.insert(schema.serviceRequests).values({
    issueId: row.id, serviceDeskId: g.desk.id, requestTypeId: rt.id, customerId: user.id, channel: 'portal', fieldValues: v.values,
  })
  await runRequestCreatedHooks({ issueId: row.id, issueKey: issue.key, deskId: g.desk.id, requestTypeId: rt.id, fieldValues: v.values })
  await onRequestCreated(row.id) // auto-categorisation rules
  return c.json({ key: issue.key, summary }, 201)
})

/** Requests the caller raised or participates in. */
app.get('/rest/servicedeskapi/portal/:slug/request', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const user = c.get('user')!
  const participating = db.select({ id: schema.requestParticipants.requestId }).from(schema.requestParticipants)
    .where(eq(schema.requestParticipants.userId, user.id))
  const rows = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(
      eq(schema.serviceRequests.serviceDeskId, g.desk.id),
      or(eq(schema.serviceRequests.customerId, user.id), inArray(schema.serviceRequests.id, participating)),
      issueVisibleSql(user.id),
    )).orderBy(desc(schema.issues.createdAt)).limit(200)
  const statuses = await db.select().from(schema.statuses)
  const sName = new Map(statuses.map((s) => [s.id, s.name]))
  // what the list shows next to each request: its type, who works on it and where its service level stands
  const typeIds = [...new Set(rows.map((r) => r.req.requestTypeId).filter((x): x is number => x != null))]
  const typeNames = new Map<number, string>()
  if (typeIds.length) for (const t of await db.select({ id: schema.requestTypes.id, name: schema.requestTypes.name }).from(schema.requestTypes).where(inArray(schema.requestTypes.id, typeIds))) typeNames.set(t.id, t.name)
  const assigneeIds = [...new Set(rows.map((r) => r.issue.assigneeId).filter((x): x is number => x != null))]
  const assignees = new Map<number, string>()
  if (assigneeIds.length) for (const u of await db.select({ id: schema.users.id, name: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, assigneeIds))) assignees.set(u.id, u.name || u.username)
  const issueIds = rows.map((r) => r.issue.id)
  const slaByIssue = new Map<number, Array<typeof schema.requestSlaStates.$inferSelect>>()
  if (issueIds.length) for (const s of await db.select().from(schema.requestSlaStates).where(inArray(schema.requestSlaStates.issueId, issueIds))) slaByIssue.set(s.issueId, [...(slaByIssue.get(s.issueId) ?? []), s])
  /** One word per request: overdue wins over paused, paused over on track, and "met" only when every clock has stopped in time. */
  const slaOf = (issueId: number): 'overdue' | 'paused' | 'on_track' | 'met' | null => {
    const l = slaByIssue.get(issueId)
    if (!l?.length) return null
    if (l.some((s) => s.breached)) return 'overdue'
    if (l.every((s) => s.stoppedAt)) return 'met'
    if (l.some((s) => !s.stoppedAt && s.pausedAt)) return 'paused'
    return 'on_track'
  }
  return c.json({
    values: rows.map((r) => ({
      key: r.issue.issueKey, summary: r.issue.summary, status: sName.get(r.issue.statusId),
      created: r.issue.createdAt, resolved: r.issue.resolvedAt, requestTypeId: r.req.requestTypeId,
      requestType: r.req.requestTypeId != null ? typeNames.get(r.req.requestTypeId) ?? null : null,
      assignee: r.issue.assigneeId != null ? assignees.get(r.issue.assigneeId) ?? null : null,
      sla: slaOf(r.issue.id),
    })),
  })
})

/** Ownership-checked loader: customers get 404 for anything that is not theirs. */
async function customerRequest(c: any, desk: Desk) {
  const user = c.get('user')!
  const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.issues.issueKey, c.req.param('key')), eq(schema.serviceRequests.serviceDeskId, desk.id))).limit(1)
  if (!row) return null
  if (row.req.customerId === user.id) return row
  const [p] = await db.select().from(schema.requestParticipants)
    .where(and(eq(schema.requestParticipants.requestId, row.req.id), eq(schema.requestParticipants.userId, user.id))).limit(1)
  return p ? row : null
}

app.get('/rest/servicedeskapi/portal/:slug/request/:key', requireAuth, async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const row = await customerRequest(c, g.desk); if (!row) return notFound(c)
  const [statuses, comments] = await Promise.all([
    db.select().from(schema.statuses).where(eq(schema.statuses.id, row.issue.statusId)).limit(1),
    db.select({ id: schema.comments.id, parentId: schema.comments.parentCommentId, body: schema.comments.body, createdAt: schema.comments.createdAt, authorId: schema.comments.authorId, author: schema.users.displayName })
      .from(schema.comments).leftJoin(schema.users, eq(schema.users.id, schema.comments.authorId))
      .where(and(eq(schema.comments.issueId, row.issue.id), eq(schema.comments.isInternal, false))).orderBy(asc(schema.comments.createdAt)),
  ])
  return c.json({
    key: row.issue.issueKey, summary: row.issue.summary, description: row.issue.description,
    status: statuses[0]?.name, created: row.issue.createdAt, resolved: row.issue.resolvedAt,
    csat: row.req.csatRating ? { rating: row.req.csatRating, comment: row.req.csatComment } : null,
    comments: comments.map((x) => ({ id: x.id, parentId: x.parentId, body: x.body, created: x.createdAt, author: x.author, mine: x.authorId === c.get('user')!.id })),
  })
})

app.post('/rest/servicedeskapi/portal/:slug/request/:key/comment', requireAuth, zj(commentBody), async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const row = await customerRequest(c, g.desk); if (!row) return notFound(c)
  { const lim = await portalCommentLimit(c, g.desk); if (lim) return lim }
  const input = c.req.valid('json')
  let parentCommentId: number | null = null
  if (input.parentId !== undefined) {
    // Customers may only reply to public comments on their own request.
    const [parent] = await db.select({ id: schema.comments.id }).from(schema.comments)
      .where(and(eq(schema.comments.id, input.parentId), eq(schema.comments.issueId, row.issue.id), eq(schema.comments.isInternal, false))).limit(1)
    if (!parent) return c.json({ errorMessages: ['Parent comment not found'] }, 400)
    parentCommentId = parent.id
  }
  const [cm] = await db.insert(schema.comments).values({
    issueId: row.issue.id, body: input.body, authorId: c.get('user')!.id, isInternal: false, parentCommentId, // customers can never post internal notes
  }).returning()
  void onCustomerReply(row.issue.id) // reopen rules (best effort, never throws)
  // Let the assignee / watchers know the customer replied (best effort).
  try {
    const { notifyCommentAdded } = await import('../services/notifications')
    await notifyCommentAdded(cm, row.issue)
  } catch (e) {
    console.error('[servicedesk] comment notification failed', e)
  }
  return c.json({ id: cm.id, createdAt: cm.createdAt }, 201)
})

app.post('/rest/servicedeskapi/portal/:slug/request/:key/participant', requireAuth, zj(z.object({ email: z.string().email().max(255) }).strict()), async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const row = await customerRequest(c, g.desk); if (!row) return notFound(c)
  if (row.req.customerId !== c.get('user')!.id) return forbidden(c)
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, c.req.valid('json').email)).limit(1)
  // Same response whether or not the account exists (no user enumeration).
  if (u && (await getDeskRole(await db.select().from(schema.users).where(eq(schema.users.id, u.id)).then((r) => r[0]), g.desk)) !== 'none') {
    await db.insert(schema.requestParticipants).values({ requestId: row.req.id, userId: u.id }).onConflictDoNothing()
  }
  return c.body(null, 204)
})

app.post('/rest/servicedeskapi/portal/:slug/request/:key/csat', requireAuth, zj(csatBody), async (c) => {
  const g = await portalGuard(c); if (isResponse(g)) return g
  const row = await customerRequest(c, g.desk); if (!row) return notFound(c)
  if (row.req.customerId !== c.get('user')!.id) return forbidden(c)
  if (!row.issue.resolutionId && !row.issue.resolvedAt) return c.json({ errorMessages: ['Request is not resolved yet'] }, 409)
  const b = c.req.valid('json')
  await db.update(schema.serviceRequests).set({ csatRating: b.rating, csatComment: b.comment ?? null, csatAt: new Date() })
    .where(eq(schema.serviceRequests.id, row.req.id))
  return c.body(null, 204)
})

/** Tells the issue view whether to offer agent features (internal notes, SLA). Never reveals other users' requests. */
app.get('/rest/servicedeskapi/request/:key/meta', requireAuth, async (c) => {
  const [row] = await db.select({ id: schema.issues.id, desk: schema.serviceRequests.serviceDeskId, customerId: schema.serviceRequests.customerId, channel: schema.serviceRequests.channel })
    .from(schema.issues).innerJoin(schema.serviceRequests, eq(schema.serviceRequests.issueId, schema.issues.id))
    .where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1)
  if (!row) return c.json({ isRequest: false, staff: false })
  const desk = await deskById(row.desk)
  const role = desk ? await getDeskRole(c.get('user'), desk) : 'none'
  if (!isStaff(role)) return c.json({ isRequest: false, staff: false })
  const sla = desk ? (await computeSlas(desk, [row.id])).get(row.id) ?? [] : []
  const [cust] = await db.select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, row.customerId)).limit(1)
  return c.json({ isRequest: true, staff: true, deskId: row.desk, sla, channel: row.channel, customer: cust ?? null })
})

export default app
