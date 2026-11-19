/**
 * Intake / triage: submissions that are not issues until a project member accepts them.
 *
 *  - Project routes (/rest/api/2/project/:key/intake...): session or token, explicit permission checks.
 *      BROWSE_PROJECTS  info, submit to intake
 *      CREATE_ISSUES    see and triage the queue (accepting creates an issue, so the right to create issues is the right to triage)
 *      PROJECT_ADMIN    settings: enable, public form, email webhook
 *  - Public form (/rest/public/intake/:slug): anonymous, unguessable slug, honeypot + per-IP and per-slug limits + size limits.
 *  - Email webhook (POST /rest/api/2/intake/:slug/email): shared secret, reuses the service desk email helpers.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { getClientIP, isAllowed } from '../middleware/rate-limit'
import { newSecret, secretMatches, sha256Hex } from './servicedesk-email'
import { cleanBody, detectAutoReply, normalizeAddress, sanitizeSubject, summaryFromSubject } from '../servicedesk/inbound-email'
import {
  DEFAULT_FIELDS, INTAKE_STATUSES, LIMITS, cleanText, generateSlug, isHoneypotTripped, isPlausibleSlug, normalizeFields,
  parseSnoozeUntil, validateSubmission, type IntakeAction,
} from '../intake/helpers'
import {
  IntakeError, PUBLIC_PENDING_CAP, applyAction, countPendingFromSource, createItem, ensureSettings, getSettings, getSettingsBySlug,
  isServiceDeskProject, loadItem, statusCounts, viewItems, wakeSnoozed, type ActionParams,
} from '../intake/service'

const app = new Hono<AppContext>()
const notFound = (c: any, msg = 'Not found') => c.json({ errorMessages: [msg] }, 404)
const isResponse = (v: unknown): v is Response => v instanceof Response
const envInt = (name: string, def: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def }
const zerr = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)

/* ------------------------------------------------------------------ */
/*  Project guard                                                      */
/* ------------------------------------------------------------------ */

type Level = 'BROWSE_PROJECTS' | 'CREATE_ISSUES' | 'PROJECT_ADMIN'

async function guard(c: any, level: Level, requireEnabled = true) {
  const user = c.get('user')!
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, String(c.req.param('key')).toUpperCase())).limit(1)
  // Unknown project and "you may not even see it" look the same.
  if (!project || !(await checkProjectPermission(user, project.id, 'BROWSE_PROJECTS'))) return notFound(c, 'Project not found') as Response
  if (level !== 'BROWSE_PROJECTS' && !(await checkProjectPermission(user, project.id, level))) return c.json({ errorMessages: ['Forbidden'] }, 403) as Response
  const settings = await getSettings(project.id)
  if (requireEnabled && !settings?.enabled) return notFound(c, 'Intake is not enabled for this project') as Response
  return { user, project, settings }
}

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

type Settings = typeof schema.intakeSettings.$inferSelect
function settingsView(s: Settings | undefined) {
  return {
    enabled: s?.enabled ?? false,
    slug: s?.slug ?? null,
    publicFormEnabled: s?.publicFormEnabled ?? false,
    publicFormPath: s ? `/intake/${s.slug}` : null,
    formTitle: s?.formTitle ?? '',
    formIntro: s?.formIntro ?? '',
    fields: normalizeFields(s?.fields ?? DEFAULT_FIELDS),
    emailEnabled: s?.emailEnabled ?? false,
    notifyLead: s?.notifyLead ?? true,
    emailConfigured: !!s?.emailSecretHash,
    emailWebhookPath: s ? `/rest/api/2/intake/${s.slug}/email` : null,
  }
}

const mode = z.enum(['off', 'optional', 'required'])
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  publicFormEnabled: z.boolean().optional(),
  formTitle: z.string().max(LIMITS.formTitle).optional(),
  formIntro: z.string().max(LIMITS.formIntro).optional(),
  fields: z.object({ name: mode, email: mode, description: mode }).strict().optional(),
  emailEnabled: z.boolean().optional(),
  notifyLead: z.boolean().optional(),
}).strict()

app.get('/rest/api/2/project/:key/intake/info', requireAuth, async (c) => {
  const g = await guard(c, 'BROWSE_PROJECTS', false); if (isResponse(g)) return g
  const canTriage = await checkProjectPermission(g.user, g.project.id, 'CREATE_ISSUES')
  const canAdmin = await checkProjectPermission(g.user, g.project.id, 'PROJECT_ADMIN')
  return c.json({ enabled: !!g.settings?.enabled, canTriage, canAdmin, canSubmit: !!g.settings?.enabled })
})

app.get('/rest/api/2/project/:key/intake/settings', requireAuth, async (c) => {
  const g = await guard(c, 'PROJECT_ADMIN', false); if (isResponse(g)) return g
  return c.json(settingsView(g.settings))
})

app.put('/rest/api/2/project/:key/intake/settings', requireAuth, async (c) => {
  const g = await guard(c, 'PROJECT_ADMIN', false); if (isResponse(g)) return g
  const parsed = settingsBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400)
  const b = parsed.data
  if (b.enabled && (await isServiceDeskProject(g.project.id))) return c.json({ errorMessages: ['Service desk projects use the portal instead of intake'] }, 400)
  const current = await ensureSettings(g.project.id)
  if (b.emailEnabled && !current.emailSecretHash) return c.json({ errorMessages: ['Create an email secret first (rotate-email-secret)'] }, 400)
  const patch: Partial<typeof schema.intakeSettings.$inferInsert> = { updatedAt: new Date() }
  if (b.enabled !== undefined) patch.enabled = b.enabled
  if (b.publicFormEnabled !== undefined) patch.publicFormEnabled = b.publicFormEnabled
  if (b.formTitle !== undefined) patch.formTitle = cleanText(b.formTitle, LIMITS.formTitle, false)
  if (b.formIntro !== undefined) patch.formIntro = cleanText(b.formIntro, LIMITS.formIntro)
  if (b.fields !== undefined) patch.fields = b.fields
  if (b.emailEnabled !== undefined) patch.emailEnabled = b.emailEnabled
  if (b.notifyLead !== undefined) patch.notifyLead = b.notifyLead
  const [row] = await db.update(schema.intakeSettings).set(patch).where(eq(schema.intakeSettings.id, current.id)).returning()
  return c.json(settingsView(row))
})

/** A new public form address; the old one stops working immediately (and so does the email webhook address). */
app.post('/rest/api/2/project/:key/intake/settings/rotate-slug', requireAuth, async (c) => {
  const g = await guard(c, 'PROJECT_ADMIN', false); if (isResponse(g)) return g
  const current = await ensureSettings(g.project.id)
  const [row] = await db.update(schema.intakeSettings).set({ slug: generateSlug(), updatedAt: new Date() }).where(eq(schema.intakeSettings.id, current.id)).returning()
  c.header('Cache-Control', 'no-store')
  return c.json(settingsView(row))
})

/** The shared secret of the email webhook is shown once; only its hash is stored. */
app.post('/rest/api/2/project/:key/intake/settings/rotate-email-secret', requireAuth, async (c) => {
  const g = await guard(c, 'PROJECT_ADMIN', false); if (isResponse(g)) return g
  const current = await ensureSettings(g.project.id)
  const secret = newSecret()
  const [row] = await db.update(schema.intakeSettings).set({ emailSecretHash: sha256Hex(secret), updatedAt: new Date() }).where(eq(schema.intakeSettings.id, current.id)).returning()
  c.header('Cache-Control', 'no-store')
  return c.json({ ...settingsView(row), secret })
})

/* ------------------------------------------------------------------ */
/*  Items                                                              */
/* ------------------------------------------------------------------ */

const submitBody = z.object({
  title: z.string().max(5000),
  description: z.string().max(100_000).optional(),
  requesterName: z.string().max(1000).optional(),
  requesterEmail: z.string().max(1000).optional(),
}).strict()

app.post('/rest/api/2/project/:key/intake/items', requireAuth, async (c) => {
  const g = await guard(c, 'BROWSE_PROJECTS'); if (isResponse(g)) return g
  const parsed = submitBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400)
  const b = parsed.data
  const v = validateSubmission(
    { title: b.title, description: b.description, name: b.requesterName ?? g.user.displayName, email: b.requesterEmail ?? g.user.email },
    { name: 'optional', email: 'optional', description: 'optional' },
  )
  if (!v.ok) return c.json({ errorMessages: v.errors }, 400)
  const viaToken = c.get('tokenScopes') != null
  const item = await createItem(g.project.id, { ...v.value, source: viaToken ? 'api' : 'app', requesterUserId: g.user.id })
  return c.json((await viewItems([item!]))[0], 201)
})

const listQuery = z.object({
  status: z.enum(INTAKE_STATUSES).optional(),
  q: z.string().max(200).optional(),
  startAt: z.coerce.number().int().min(0).max(1_000_000).optional(),
  maxResults: z.coerce.number().int().min(1).max(100).optional(),
})

app.get('/rest/api/2/project/:key/intake/items', requireAuth, async (c) => {
  const g = await guard(c, 'CREATE_ISSUES'); if (isResponse(g)) return g
  const q = listQuery.safeParse(c.req.query())
  if (!q.success) return c.json({ errorMessages: zerr(q.error) }, 400)
  const { status = 'pending', startAt = 0, maxResults = 50 } = q.data
  await wakeSnoozed(g.project.id)
  const conds = [eq(schema.intakeItems.projectId, g.project.id), eq(schema.intakeItems.status, status)]
  const text = q.data.q?.trim()
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conds.push(or(ilike(schema.intakeItems.title, like), ilike(schema.intakeItems.description, like), ilike(schema.intakeItems.requesterEmail, like), ilike(schema.intakeItems.requesterName, like))!)
  }
  const where = and(...conds)
  const order = status === 'pending' ? [asc(schema.intakeItems.createdAt), asc(schema.intakeItems.id)]
    : status === 'snoozed' ? [asc(schema.intakeItems.snoozedUntil), asc(schema.intakeItems.id)]
    : [desc(schema.intakeItems.updatedAt), desc(schema.intakeItems.id)]
  const rows = await db.select().from(schema.intakeItems).where(where).orderBy(...order).limit(maxResults).offset(startAt)
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.intakeItems).where(where)
  return c.json({ startAt, maxResults, total: n, counts: await statusCounts(g.project.id), items: await viewItems(rows) })
})

app.get('/rest/api/2/project/:key/intake/items/:itemId', requireAuth, async (c) => {
  const g = await guard(c, 'CREATE_ISSUES'); if (isResponse(g)) return g
  await wakeSnoozed(g.project.id)
  const item = await loadItem(g.project.id, Number(c.req.param('itemId')))
  if (!item) return notFound(c, 'Intake item not found')
  return c.json((await viewItems([item]))[0])
})

const actionParams = z.object({
  issueTypeId: z.number().int().positive().optional(),
  priorityId: z.number().int().positive().nullable().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  summary: z.string().max(1000).optional(),
  note: z.string().max(LIMITS.reason).optional(),
  reason: z.string().max(LIMITS.reason).optional(),
  until: z.string().max(64).optional(),
  issue: z.union([z.string().max(64), z.number().int().positive()]).optional(),
}).strict()

function toParams(b: z.infer<typeof actionParams>, action: IntakeAction): ActionParams | string {
  const p: ActionParams = { issueTypeId: b.issueTypeId, priorityId: b.priorityId, assigneeId: b.assigneeId, summary: b.summary, note: b.note, reason: b.reason, issue: b.issue }
  if (action === 'snooze') {
    const u = parseSnoozeUntil(b.until)
    if (!u.ok) return u.error
    p.until = u.date
  }
  return p
}

const ACTIONS: IntakeAction[] = ['accept', 'decline', 'snooze', 'duplicate', 'reopen']
for (const action of ACTIONS) {
  app.post(`/rest/api/2/project/:key/intake/items/:itemId/${action}`, requireAuth, async (c) => {
    const g = await guard(c, 'CREATE_ISSUES'); if (isResponse(g)) return g
    const parsed = actionParams.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400)
    const params = toParams(parsed.data, action)
    if (typeof params === 'string') return c.json({ errorMessages: [params] }, 400)
    await wakeSnoozed(g.project.id)
    const item = await loadItem(g.project.id, Number(c.req.param('itemId')))
    if (!item) return notFound(c, 'Intake item not found')
    try {
      return c.json(await applyAction(item, action, g.user, params))
    } catch (e) {
      if (e instanceof IntakeError) return c.json({ errorMessages: [e.message] }, e.status)
      throw e
    }
  })
}

const bulkBody = actionParams.extend({
  ids: z.array(z.number().int().positive()).min(1).max(LIMITS.bulk),
  action: z.enum(['accept', 'decline', 'snooze', 'duplicate', 'reopen']),
}).strict()

/** Same action for many items; every item is decided on its own and reported on its own. */
app.post('/rest/api/2/project/:key/intake/bulk', requireAuth, async (c) => {
  const g = await guard(c, 'CREATE_ISSUES'); if (isResponse(g)) return g
  const parsed = bulkBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400)
  const { ids, action, ...rest } = parsed.data
  const params = toParams(rest, action)
  if (typeof params === 'string') return c.json({ errorMessages: [params] }, 400)
  await wakeSnoozed(g.project.id)
  const results: Array<{ id: number; ok: boolean; status?: string; error?: string }> = []
  for (const id of [...new Set(ids)]) {
    const item = await loadItem(g.project.id, id)
    if (!item) { results.push({ id, ok: false, error: 'Intake item not found' }); continue }
    try {
      const v = await applyAction(item, action, g.user, params)
      results.push({ id, ok: true, status: v.status })
    } catch (e) {
      if (e instanceof IntakeError) results.push({ id, ok: false, error: e.message })
      else { console.error('[intake] bulk action failed:', (e as Error)?.name); results.push({ id, ok: false, error: 'Internal error' }) }
    }
  }
  return c.json({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length })
})

/* ------------------------------------------------------------------ */
/*  Public form                                                        */
/* ------------------------------------------------------------------ */

/** The form definition. Reveals only the title, the intro and which fields are collected, never the project. */
app.get('/rest/public/intake/:slug', async (c) => {
  c.header('Cache-Control', 'no-store')
  const slug = c.req.param('slug')
  if (!isPlausibleSlug(slug)) return notFound(c)
  const s = await getSettingsBySlug(slug)
  if (!s || !s.enabled || !s.publicFormEnabled) return notFound(c)
  return c.json({ title: s.formTitle || 'Submit a request', intro: s.formIntro, fields: normalizeFields(s.fields) })
})

const publicBody = z.object({
  title: z.string().max(5000),
  description: z.string().max(100_000).optional(),
  name: z.string().max(1000).optional(),
  email: z.string().max(1000).optional(),
  website: z.unknown().optional(), // honeypot
}).strict()

app.post('/rest/public/intake/:slug', async (c) => {
  c.header('Cache-Control', 'no-store')
  // Limits come first so that probing slugs, oversized bodies and bots all spend the same budget.
  const ip = await isAllowed(`veqsio:ratelimit:intake-public:${getClientIP(c)}`, { maxRequests: envInt('INTAKE_PUBLIC_IP_MAX', 5), windowMs: envInt('INTAKE_PUBLIC_IP_WINDOW_MS', 600_000) })
  if (!ip.allowed) { c.header('Retry-After', String(ip.retryAfter)); return c.json({ errorMessages: ['Too many submissions, try again later'] }, 429) }

  const slug = c.req.param('slug')
  if (!isPlausibleSlug(slug)) return notFound(c)
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > LIMITS.publicBody) return c.json({ errorMessages: ['Payload too large'] }, 413)
  const raw = await c.req.text()
  if (raw.length > LIMITS.publicBody) return c.json({ errorMessages: ['Payload too large'] }, 413)

  const s = await getSettingsBySlug(slug)
  if (!s || !s.enabled || !s.publicFormEnabled) return notFound(c)
  const perSlug = await isAllowed(`veqsio:ratelimit:intake-public-slug:${s.id}`, { maxRequests: envInt('INTAKE_PUBLIC_SLUG_MAX', 60), windowMs: 3_600_000 })
  if (!perSlug.allowed) { c.header('Retry-After', String(perSlug.retryAfter)); return c.json({ errorMessages: ['This form is receiving too many submissions, try again later'] }, 429) }

  let json: unknown
  try { json = JSON.parse(raw) } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400) }
  const parsed = publicBody.safeParse(json)
  if (!parsed.success) return c.json({ errorMessages: ['Invalid submission'] }, 400)
  const body = parsed.data

  // Bots fill every field. Answer exactly like a success and store nothing.
  if (isHoneypotTripped(body.website)) return c.json({ status: 'received' }, 201)

  const v = validateSubmission(body, normalizeFields(s.fields))
  if (!v.ok) return c.json({ errorMessages: v.errors }, 400)
  if ((await countPendingFromSource(s.projectId, 'form')) >= PUBLIC_PENDING_CAP) {
    return c.json({ errorMessages: ['This form is temporarily not accepting submissions'] }, 429)
  }
  await createItem(s.projectId, { ...v.value, source: 'form' })
  return c.json({ status: 'received' }, 201)
})

/* ------------------------------------------------------------------ */
/*  Email webhook                                                      */
/* ------------------------------------------------------------------ */

const emailBody = z.object({
  messageId: z.string().trim().min(1).max(500),
  from: z.string().min(1).max(998),
  subject: z.string().max(5000).optional().default(''),
  text: z.string().max(200_000).optional().default(''),
  headers: z.record(z.string().max(200), z.string().max(2000)).optional()
    .refine((h) => !h || Object.keys(h).length <= 200, 'too many headers'),
}).strict()

app.post('/rest/api/2/intake/:slug/email', async (c) => {
  const slug = c.req.param('slug')
  const limit = await isAllowed(`veqsio:ratelimit:intake-email:${getClientIP(c)}`, { maxRequests: envInt('INTAKE_EMAIL_IP_MAX', 120), windowMs: 60_000 })
  if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); return c.json({ errorMessages: ['Rate limit exceeded'] }, 429) }

  const s = isPlausibleSlug(slug) ? await getSettingsBySlug(slug) : undefined
  if (!s || !s.enabled || !s.emailEnabled || !s.emailSecretHash) return notFound(c)
  if (!secretMatches(c.req.header('x-veqsio-inbound-secret') ?? '', s.emailSecretHash)) return c.json({ errorMessages: ['Unauthorized'] }, 401)

  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > LIMITS.emailBody) return c.json({ errorMessages: ['Payload too large'] }, 413)
  const raw = await c.req.text()
  if (raw.length > LIMITS.emailBody) return c.json({ errorMessages: ['Payload too large'] }, 413)
  let json: unknown
  try { json = JSON.parse(raw) } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400) }
  const parsed = emailBody.safeParse(json)
  if (!parsed.success) return c.json({ errorMessages: ['Invalid payload'] }, 400)
  const msg = parsed.data

  const from = normalizeAddress(msg.from)
  if (!from) return c.json({ errorMessages: ['Invalid sender address'] }, 400)
  const subject = sanitizeSubject(msg.subject)
  // Auto-replies and bulk mail would create noise (and loops with the requester notifications).
  if (detectAutoReply(msg.headers, subject)) return c.json({ status: 'rejected' })

  const name = /^\s*"?([^"<]{1,100}?)"?\s*</.exec(msg.from)?.[1]?.trim() ?? ''
  const v = validateSubmission(
    { title: summaryFromSubject(subject), description: cleanBody(msg.text), name, email: from },
    { name: 'optional', email: 'optional', description: 'optional' },
  )
  if (!v.ok) return c.json({ status: 'rejected' })
  if ((await countPendingFromSource(s.projectId, 'email')) >= PUBLIC_PENDING_CAP) return c.json({ errorMessages: ['Queue is full'] }, 429)
  const item = await createItem(s.projectId, { ...v.value, source: 'email', sourceRef: msg.messageId })
  return item ? c.json({ status: 'created' }, 201) : c.json({ status: 'duplicate' })
})

export default app
