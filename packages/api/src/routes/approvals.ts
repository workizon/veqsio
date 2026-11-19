import { issueVisibleSql } from '../security/issue-security'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { issueDeskAccess, getDeskRole, isStaff } from '../servicedesk/service'
import { loadPortalDesk } from '../servicedesk/access'
import { consumeLimit } from '../servicedesk/limits'
import { recordAudit } from '../audit/log'
import { RULES, parseAutoRule, validateRuleSpec, type Rule } from '../approvals/engine'
import {
  ApprovalError, createApproval, recordDecision, cancelApproval, serializeApprovals, pendingForUser, resolveApproverIds, asIds,
  type ApprovalRow,
} from '../approvals/service'

/**
 * Approvals API. Authorisation model (deny by default):
 *  - an approval is visible/decidable only to its assigned approvers (everything else answers 404);
 *  - issue approval lists are visible to users who may browse the project (staff for service requests);
 *  - requesting needs TRANSITION_ISSUES, cancelling needs being the requester or PROJECT_ADMIN;
 *  - templates are managed by project admins.
 */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)

const zj = <T extends z.ZodTypeAny>(s: T) => zValidator('json', s, (r, c: Context) => {
  if (!r.success) return c.json({ errorMessages: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message) }, 400)
})

function fail(c: Context, e: unknown) {
  if (e instanceof ApprovalError) return c.json({ errorMessages: [e.message] }, e.status)
  throw e
}

/* ------------------------------------------------------------------ */
/*  Schemas                                                             */
/* ------------------------------------------------------------------ */

const autoRuleSchema = z.object({
  field: z.enum(['priority', 'issuetype']),
  op: z.enum(['eq', 'neq', 'in']),
  value: z.union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1).max(20)]),
}).strict().nullable()

const idList = (max: number) => z.array(z.number().int().positive()).max(max)

const templateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  approverUserIds: idList(50).default([]),
  approverGroupIds: idList(20).default([]),
  rule: z.enum(RULES).default('all'),
  ruleThreshold: z.number().int().min(1).max(1000).nullable().optional(),
  autoApproveWhen: autoRuleSchema.optional(),
  autoDeclineWhen: autoRuleSchema.optional(),
  reminderIntervalHours: z.number().int().min(1).max(720).nullable().optional(),
  expiryHours: z.number().int().min(1).max(8760).nullable().optional(),
  onApprovedTransitionId: z.number().int().positive().nullable().optional(),
  onDeclinedTransitionId: z.number().int().positive().nullable().optional(),
}).strict()

const requestBody = z.object({
  templateId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  approverUserIds: idList(50).optional(),
  approverGroupIds: idList(20).optional(),
  rule: z.enum(RULES).optional(),
  ruleThreshold: z.number().int().min(1).max(1000).nullable().optional(),
  reminderIntervalHours: z.number().int().min(1).max(720).nullable().optional(),
  expiryHours: z.number().int().min(1).max(8760).nullable().optional(),
}).strict().superRefine((b, ctx) => {
  const adHoc = (b.approverUserIds?.length ?? 0) + (b.approverGroupIds?.length ?? 0) > 0
  if (b.templateId !== undefined && (adHoc || b.rule || b.name || b.ruleThreshold != null || b.reminderIntervalHours != null || b.expiryHours != null)) {
    ctx.addIssue({ code: 'custom', message: 'Give either templateId or ad-hoc approvers, not both' })
  }
  if (b.templateId === undefined && !adHoc) ctx.addIssue({ code: 'custom', message: 'templateId or at least one approver is required' })
})

const decisionBody = z.object({ decision: z.enum(['approved', 'declined']), comment: z.string().max(5000).optional() }).strict()

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const maxDecisionsPerHour = () => {
  const n = Number(process.env.APPROVAL_MAX_DECISIONS_PER_HOUR)
  return Number.isInteger(n) && n > 0 ? n : 60
}

/** 429 Response when the user decides too often (blocks scripted spamming of approvals). */
async function decisionLimited(c: Context, userId: number): Promise<Response | null> {
  const r = await consumeLimit(`apdec:${userId}`, maxDecisionsPerHour())
  if (r.allowed) return null
  c.header('Retry-After', String(r.retryAfter))
  return c.json({ errorMessages: ['Too many decisions. Please try again later.'] }, 429)
}

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
  return (p ?? null) as typeof schema.projects.$inferSelect | null
}

async function issueByKey(key: string) {
  const [i] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key)).limit(1)
  return (i ?? null) as typeof schema.issues.$inferSelect | null
}

/** True when the user may see the whole issue (project browse permission, and desk staff for service requests). */
async function canBrowseIssue(user: any, issue: { id: number; projectId: number }): Promise<boolean> {
  if (!(await checkProjectPermission(user, issue.projectId, 'BROWSE_PROJECTS'))) return false
  const access = await issueDeskAccess(user, issue.id)
  return access.staff
}

async function validateTemplateRefs(body: { approverUserIds: number[]; approverGroupIds: number[]; onApprovedTransitionId?: number | null; onDeclinedTransitionId?: number | null }): Promise<string | null> {
  if (body.approverUserIds.length) {
    const rows = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, body.approverUserIds))
    if (rows.length !== new Set(body.approverUserIds).size) return 'Unknown approver user'
  }
  if (body.approverGroupIds.length) {
    const rows = await db.select({ id: schema.groups.id }).from(schema.groups).where(inArray(schema.groups.id, body.approverGroupIds))
    if (rows.length !== new Set(body.approverGroupIds).size) return 'Unknown approver group'
  }
  const tids = [body.onApprovedTransitionId, body.onDeclinedTransitionId].filter((x): x is number => typeof x === 'number')
  if (tids.length) {
    const rows = await db.select({ id: schema.workflowTransitions.id }).from(schema.workflowTransitions).where(inArray(schema.workflowTransitions.id, tids))
    if (rows.length !== new Set(tids).size) return 'Unknown workflow transition'
  }
  return null
}

function checkTemplateLogic(b: z.infer<typeof templateBody>): string | null {
  if (b.approverUserIds.length + b.approverGroupIds.length === 0) return 'At least one approver user or group is required'
  const e = validateRuleSpec({ rule: b.rule as Rule, threshold: b.ruleThreshold ?? null }, 1000)
  if (e) return e
  if (b.rule === 'n_of_m' && b.approverGroupIds.length === 0 && b.ruleThreshold! > new Set(b.approverUserIds).size) return 'Threshold is larger than the number of approvers'
  for (const r of [b.autoApproveWhen, b.autoDeclineWhen]) {
    const p = parseAutoRule(r ?? null)
    if (!p.ok) return p.error
  }
  return null
}

const templateView = (t: typeof schema.approvalTemplates.$inferSelect) => ({
  id: t.id, projectId: t.projectId, name: t.name, description: t.description,
  approverUserIds: asIds(t.approverUserIds), approverGroupIds: asIds(t.approverGroupIds),
  rule: t.rule, ruleThreshold: t.ruleThreshold, autoApproveWhen: t.autoApproveWhen, autoDeclineWhen: t.autoDeclineWhen,
  reminderIntervalHours: t.reminderIntervalHours, expiryHours: t.expiryHours,
  onApprovedTransitionId: t.onApprovedTransitionId, onDeclinedTransitionId: t.onDeclinedTransitionId,
})

/* ------------------------------------------------------------------ */
/*  Templates (project admin)                                           */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/project/:key/approval-template', requireAuth, async (c) => {
  const user = c.get('user')!
  const p = await projectByKey(c.req.param('key')!)
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return notFound(c)
  const isAdmin = await checkProjectPermission(user, p.id, 'PROJECT_ADMIN')
  if (!isAdmin && !(await checkProjectPermission(user, p.id, 'TRANSITION_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  const rows = await db.select().from(schema.approvalTemplates).where(eq(schema.approvalTemplates.projectId, p.id)).orderBy(schema.approvalTemplates.name)
  // Agents picking a template see only what they need; the approver spec is for administrators.
  return c.json({ values: rows.map((t) => (isAdmin ? templateView(t) : { id: t.id, name: t.name, description: t.description, rule: t.rule, ruleThreshold: t.ruleThreshold })) })
})

app.post('/rest/api/2/project/:key/approval-template', requireAuth, zj(templateBody), async (c) => {
  const user = c.get('user')!
  const p = await projectByKey(c.req.param('key')!)
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return notFound(c)
  if (!(await checkProjectPermission(user, p.id, 'PROJECT_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  const b = c.req.valid('json')
  const err = checkTemplateLogic(b) ?? (await validateTemplateRefs(b))
  if (err) return c.json({ errorMessages: [err] }, 400)
  const [dup] = await db.select({ id: schema.approvalTemplates.id }).from(schema.approvalTemplates)
    .where(and(eq(schema.approvalTemplates.projectId, p.id), eq(schema.approvalTemplates.name, b.name))).limit(1)
  if (dup) return c.json({ errorMessages: ['A template with this name already exists'] }, 409)
  const [row] = await db.insert(schema.approvalTemplates).values({
    projectId: p.id, name: b.name, description: b.description ?? null, approverUserIds: b.approverUserIds, approverGroupIds: b.approverGroupIds,
    rule: b.rule, ruleThreshold: b.ruleThreshold ?? null, autoApproveWhen: b.autoApproveWhen ?? null, autoDeclineWhen: b.autoDeclineWhen ?? null,
    reminderIntervalHours: b.reminderIntervalHours ?? null, expiryHours: b.expiryHours ?? null,
    onApprovedTransitionId: b.onApprovedTransitionId ?? null, onDeclinedTransitionId: b.onDeclinedTransitionId ?? null,
  }).returning()
  void recordAudit({ actorId: user.id, actorName: user.username, action: 'approval-template.create', targetType: 'approval-template', target: `${p.projectKey}/${row.name}` })
  return c.json(templateView(row), 201)
})

app.put('/rest/api/2/project/:key/approval-template/:id', requireAuth, zj(templateBody.partial()), async (c) => {
  const user = c.get('user')!
  const p = await projectByKey(c.req.param('key')!)
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return notFound(c)
  if (!(await checkProjectPermission(user, p.id, 'PROJECT_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  // Scoped by project: a template id of another project is simply not found.
  const [cur] = await db.select().from(schema.approvalTemplates)
    .where(and(eq(schema.approvalTemplates.id, Number(c.req.param('id'))), eq(schema.approvalTemplates.projectId, p.id))).limit(1)
  if (!cur) return notFound(c)
  const patch = c.req.valid('json')
  const { id: _id, projectId: _pid, ...stored } = templateView(cur)
  const merged = templateBody.parse({ ...stored, ...patch }) // omitted keys keep their stored value
  const err = checkTemplateLogic(merged) ?? (await validateTemplateRefs(merged))
  if (err) return c.json({ errorMessages: [err] }, 400)
  if (merged.name !== cur.name) {
    const [dup] = await db.select({ id: schema.approvalTemplates.id }).from(schema.approvalTemplates)
      .where(and(eq(schema.approvalTemplates.projectId, p.id), eq(schema.approvalTemplates.name, merged.name))).limit(1)
    if (dup) return c.json({ errorMessages: ['A template with this name already exists'] }, 409)
  }
  const [row] = await db.update(schema.approvalTemplates).set({
    name: merged.name, description: merged.description ?? null, approverUserIds: merged.approverUserIds, approverGroupIds: merged.approverGroupIds,
    rule: merged.rule, ruleThreshold: merged.ruleThreshold ?? null, autoApproveWhen: merged.autoApproveWhen ?? null, autoDeclineWhen: merged.autoDeclineWhen ?? null,
    reminderIntervalHours: merged.reminderIntervalHours ?? null, expiryHours: merged.expiryHours ?? null,
    onApprovedTransitionId: merged.onApprovedTransitionId ?? null, onDeclinedTransitionId: merged.onDeclinedTransitionId ?? null,
    updatedAt: new Date(),
  }).where(eq(schema.approvalTemplates.id, cur.id)).returning()
  void recordAudit({ actorId: user.id, actorName: user.username, action: 'approval-template.update', targetType: 'approval-template', target: `${p.projectKey}/${row.name}` })
  return c.json(templateView(row))
})

app.delete('/rest/api/2/project/:key/approval-template/:id', requireAuth, async (c) => {
  const user = c.get('user')!
  const p = await projectByKey(c.req.param('key')!)
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return notFound(c)
  if (!(await checkProjectPermission(user, p.id, 'PROJECT_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  const [row] = await db.delete(schema.approvalTemplates)
    .where(and(eq(schema.approvalTemplates.id, Number(c.req.param('id'))), eq(schema.approvalTemplates.projectId, p.id))).returning()
  if (!row) return notFound(c)
  void recordAudit({ actorId: user.id, actorName: user.username, action: 'approval-template.delete', targetType: 'approval-template', target: `${p.projectKey}/${row.name}` })
  return c.body(null, 204)
})

/* ------------------------------------------------------------------ */
/*  Approvals on an issue                                               */
/* ------------------------------------------------------------------ */

app.post('/rest/api/2/issue/:key/approval', requireAuth, zj(requestBody), async (c) => {
  const user = c.get('user')!
  const issue = await issueByKey(c.req.param('key')!)
  if (!issue || !(await canBrowseIssue(user, issue))) return notFound(c)
  if (!(await checkProjectPermission(user, issue.projectId, 'TRANSITION_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  const b = c.req.valid('json')
  try {
    let template: typeof schema.approvalTemplates.$inferSelect | undefined
    if (b.templateId !== undefined) {
      [template] = await db.select().from(schema.approvalTemplates)
        .where(and(eq(schema.approvalTemplates.id, b.templateId), eq(schema.approvalTemplates.projectId, issue.projectId))).limit(1)
      if (!template) return c.json({ errorMessages: ['Template not found'] }, 404)
    } else {
      const users = b.approverUserIds ?? []
      const groups = b.approverGroupIds ?? []
      if (users.length) {
        const found = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, users))
        if (found.length !== new Set(users).size) return c.json({ errorMessages: ['Unknown approver user'] }, 400)
      }
      if (groups.length) {
        const found = await db.select({ id: schema.groups.id }).from(schema.groups).where(inArray(schema.groups.id, groups))
        if (found.length !== new Set(groups).size) return c.json({ errorMessages: ['Unknown approver group'] }, 400)
      }
    }
    const { approval, after } = await db.transaction((tx) => createApproval(tx, {
      issueId: issue.id, createdBy: user.id, template,
      adHoc: template ? undefined : {
        name: b.name ?? 'Approval', userIds: b.approverUserIds ?? [], groupIds: b.approverGroupIds ?? [],
        rule: (b.rule ?? 'all') as Rule, threshold: b.ruleThreshold ?? null,
        reminderIntervalHours: b.reminderIntervalHours ?? null, expiryHours: b.expiryHours ?? null,
      },
    }))
    for (const fn of after) await fn()
    void recordAudit({ actorId: user.id, actorName: user.username, action: 'approval.request', targetType: 'approval', target: String(approval!.id), details: { issue: issue.issueKey } })
    const [view] = await serializeApprovals([approval!], user.id, { full: true })
    return c.json(view, 201)
  } catch (e) {
    return fail(c, e)
  }
})

app.get('/rest/api/2/issue/:key/approval', requireAuth, async (c) => {
  const user = c.get('user')!
  const issue = await issueByKey(c.req.param('key')!)
  if (!issue) return notFound(c)
  const full = await canBrowseIssue(user, issue)
  let rows: ApprovalRow[]
  if (full) {
    rows = await db.select().from(schema.approvals).where(eq(schema.approvals.issueId, issue.id)).orderBy(desc(schema.approvals.id))
  } else {
    // Not allowed to see the issue: only approvals addressed to the caller, without other approvers' decisions.
    rows = await db.select({ a: schema.approvals }).from(schema.approvals)
      .innerJoin(schema.approvalApprovers, eq(schema.approvalApprovers.approvalId, schema.approvals.id))
      .where(and(eq(schema.approvals.issueId, issue.id), eq(schema.approvalApprovers.userId, user.id)))
      .orderBy(desc(schema.approvals.id)).then((r) => r.map((x) => x.a))
    if (rows.length === 0) return notFound(c)
  }
  return c.json({ values: await serializeApprovals(rows, user.id, { full }) })
})

/** My pending approvals, oldest first. */
app.get('/rest/api/2/approval/pending', requireAuth, async (c) => {
  const user = c.get('user')!
  const startAt = Math.max(0, Math.min(Number(c.req.query('startAt')) || 0, 1_000_000))
  const maxResults = Math.max(1, Math.min(Number(c.req.query('maxResults')) || 50, 100))
  const { total, rows } = await pendingForUser(user.id, startAt, maxResults)
  const views = await serializeApprovals(rows.map((r) => r.a), user.id, { full: false })
  const values = []
  for (const r of rows) {
    const view = views.find((v) => v.id === r.a.id)!
    const [sr] = await db.select({ slug: schema.serviceDesks.slug, deskId: schema.serviceDesks.id, projectId: schema.serviceDesks.projectId }).from(schema.serviceRequests)
      .innerJoin(schema.serviceDesks, eq(schema.serviceDesks.id, schema.serviceRequests.serviceDeskId))
      .where(eq(schema.serviceRequests.issueId, r.a.issueId)).limit(1)
    let portalSlug: string | null = null
    if (sr) {
      const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, sr.deskId)).limit(1)
      if (!isStaff(await getDeskRole(user, desk))) portalSlug = sr.slug
    }
    values.push({ ...view, issue: { key: r.issueKey, summary: r.summary }, project: { key: r.projectKey, name: r.projectName }, portalSlug })
  }
  return c.json({ startAt, maxResults, total, isLast: startAt + values.length >= total, values })
})

app.post('/rest/api/2/approval/:id/decision', requireAuth, zj(decisionBody), async (c) => {
  const user = c.get('user')!
  const lim = await decisionLimited(c, user.id); if (lim) return lim
  const b = c.req.valid('json')
  try {
    await recordDecision(Number(c.req.param('id')), user.id, b.decision, b.comment)
    const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, Number(c.req.param('id')))).limit(1)
    const [view] = await serializeApprovals([a], user.id, { full: false })
    return c.json(view)
  } catch (e) {
    return fail(c, e)
  }
})

app.delete('/rest/api/2/approval/:id', requireAuth, async (c) => {
  const user = c.get('user')!
  const [row] = await db.select({ a: schema.approvals, projectId: schema.issues.projectId }).from(schema.approvals)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.approvals.issueId))
    .where(eq(schema.approvals.id, Number(c.req.param('id')))).limit(1)
  if (!row) return notFound(c)
  const isRequester = row.a.createdBy === user.id
  if (!isRequester && !(await checkProjectPermission(user, row.projectId, 'PROJECT_ADMIN'))) return notFound(c)
  try {
    await cancelApproval(row.a.id, user.id)
    return c.body(null, 204)
  } catch (e) {
    return fail(c, e)
  }
})

/* ------------------------------------------------------------------ */
/*  Customer portal: approvals addressed to the signed-in customer      */
/* ------------------------------------------------------------------ */

async function portalApprovalRows(userId: number, deskId: number, key: string | undefined) {
  const conds = [
    eq(schema.approvalApprovers.userId, userId),
    eq(schema.serviceRequests.serviceDeskId, deskId),
    ...(key
      ? [eq(schema.issues.issueKey, key)]
      : [
          eq(schema.approvals.status, 'pending'),
          sql`not exists (select 1 from approval_decisions d where d.approval_id = ${schema.approvals.id} and d.approver_id = ${userId})`,
          sql`(${schema.approvals.expiresAt} is null or ${schema.approvals.expiresAt} > now())`,
        ]),
  ]
  return db.select({ a: schema.approvals, key: schema.issues.issueKey, summary: schema.issues.summary }).from(schema.approvals)
    .innerJoin(schema.approvalApprovers, eq(schema.approvalApprovers.approvalId, schema.approvals.id))
    .innerJoin(schema.issues, eq(schema.issues.id, schema.approvals.issueId))
    .innerJoin(schema.serviceRequests, eq(schema.serviceRequests.issueId, schema.issues.id))
    .where(and(...conds, issueVisibleSql(userId))).orderBy(desc(schema.approvals.id)).limit(100)
}

app.get('/rest/servicedeskapi/portal/:slug/approvals', requireAuth, async (c) => {
  const user = c.get('user')!
  const desk = await loadPortalDesk(user, c.req.param('slug')!)
  if (!desk) return notFound(c)
  const key = c.req.query('key') || undefined
  const rows = await portalApprovalRows(user.id, desk.id, key)
  const views = await serializeApprovals(rows.map((r) => r.a), user.id, { full: false })
  // Customers see the request summary and their own decision only: never other approvers or internal data.
  return c.json({
    values: rows.map((r) => {
      const v = views.find((x) => x.id === r.a.id)!
      return {
        id: v.id, name: v.name, status: v.status, created: v.created, expires: v.expires,
        myDecision: v.myDecision, canDecide: v.canDecide, request: { key: r.key, summary: r.summary },
      }
    }),
  })
})

app.post('/rest/servicedeskapi/portal/:slug/approvals/:id/decision', requireAuth, zj(decisionBody), async (c) => {
  const user = c.get('user')!
  const desk = await loadPortalDesk(user, c.req.param('slug')!)
  if (!desk) return notFound(c)
  const lim = await decisionLimited(c, user.id); if (lim) return lim
  const b = c.req.valid('json')
  try {
    await recordDecision(Number(c.req.param('id')), user.id, b.decision, b.comment, { scopeDeskId: desk.id })
    return c.body(null, 204)
  } catch (e) {
    return fail(c, e)
  }
})

export default app
