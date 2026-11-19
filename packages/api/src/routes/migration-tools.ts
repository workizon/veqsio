import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { ToolAuthError } from '../migration/tools/http'
import { sanitizeKey } from '../migration/tools/engine'
import { JsonFileError, MAX_JSON_BYTES } from '../migration/tools/generic'
import { cancelMigration, createAdapter, redact, SOURCE_INFO, startToolImport } from '../migration/tools'
import { TOOL_SOURCES, type ExtractOptions, type ToolSourceId } from '../migration/tools/model'

/**
 * Import from Linear, Asana, ClickUp (live, personal token) and from a generic JSON file. All routes are SYSTEM_ADMIN only.
 * Tokens are used for the duration of the request / background job and are never stored, logged or echoed.
 * The provider hosts are fixed (api.linear.app, app.asana.com, api.clickup.com), so no user supplied URL is ever fetched.
 *
 *   GET  /tools/sources                     descriptions of all sources
 *   POST /tools/:source/test                token check -> who am I
 *   POST /tools/:source/analyze             list teams / projects / spaces (or the projects of a JSON file)
 *   POST /tools/:source/run                 dryRun=true (default): preview report; dryRun=false: import. Background job.
 *   GET  /tools/sessions[/:sessionId]       history, progress and report
 *   POST /tools/sessions/:sessionId/cancel
 */
const app = new Hono<AppContext>()
const guards = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

const optionsSchema = z.object({
  containerIds: z.array(z.string().min(1).max(200)).max(5000).optional(),
  workspaceId: z.string().max(100).optional(),
  groupBy: z.enum(['space', 'list']).optional(),
  includeComments: z.boolean().optional(),
  onExisting: z.enum(['update', 'skip']).optional(),
  userMapping: z.record(z.string().max(255)).optional(),
  createMissingUsers: z.boolean().optional(),
  projectKeys: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)).optional(),
  updatedSince: z.string().datetime().optional(),
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/).optional(),
}).strict()

const inputSchema = z.object({
  token: z.string().min(6).max(500).optional(),
  json: z.string().min(2).max(MAX_JSON_BYTES).optional(),
  dryRun: z.boolean().default(true),
  options: optionsSchema.default({}),
}).strict()
type Input = z.infer<typeof inputSchema>

const sourceOf = (c: Context): ToolSourceId | null => {
  const s = c.req.param('source') as ToolSourceId
  return TOOL_SOURCES.includes(s) ? s : null
}

/** JSON body, or multipart/form-data with `file`, `options` (JSON) and `dryRun` for large JSON files. */
async function readInput(c: Context): Promise<{ ok: true; value: Input } | { ok: false; status: 400 | 413; message: string }> {
  const ct = (c.req.header('content-type') || '').toLowerCase()
  let raw: unknown
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) return { ok: false, status: 400, message: 'Attach the JSON file as the "file" field' }
    if (file.size > MAX_JSON_BYTES) return { ok: false, status: 413, message: 'JSON file is larger than 50 MB' }
    let options: unknown = {}
    try { options = form.options ? JSON.parse(String(form.options)) : {} } catch { return { ok: false, status: 400, message: 'options must be JSON' } }
    raw = { json: await file.text(), dryRun: form.dryRun === undefined ? true : String(form.dryRun) === 'true', options }
  } else {
    try { raw = await c.req.json() } catch { return { ok: false, status: 400, message: 'Invalid JSON body' } }
  }
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }
  return { ok: true, value: parsed.data }
}

function adapterFor(source: ToolSourceId, input: Input) {
  const info = SOURCE_INFO[source]
  if (info.mode === 'live' && !input.token) throw new JsonFileError('An API token is required')
  if (info.mode === 'file' && !input.json) throw new JsonFileError('A JSON file is required')
  return createAdapter(source, { token: input.token, json: input.json, namespace: input.options.namespace })
}

function extractOptions(o: Input['options']): ExtractOptions {
  return {
    containerIds: o.containerIds, workspaceId: o.workspaceId, groupBy: o.groupBy, includeComments: o.includeComments,
    updatedSince: o.updatedSince ? new Date(o.updatedSince) : undefined,
  }
}

function describe(e: unknown, secrets: Array<string | undefined> = []): { message: string; code: string } {
  const message = redact(e instanceof Error ? e.message : 'Unknown error', secrets.filter(Boolean) as string[])
  return { message, code: e instanceof ToolAuthError ? 'AUTH_FAILED' : e instanceof JsonFileError ? 'INVALID_FILE' : 'IMPORT_ERROR' }
}

app.get('/rest/api/2/migration/tools/sources', ...guards, (c) => c.json({ sources: TOOL_SOURCES.map((s) => SOURCE_INFO[s]) }))

app.post('/rest/api/2/migration/tools/:source/test', ...guards, async (c) => {
  const source = sourceOf(c)
  if (!source) return c.json({ errorMessages: ['Unknown source'] }, 404)
  const input = await readInput(c)
  if (!input.ok) return c.json({ errorMessages: [input.message] }, input.status)
  try {
    const viewer = await adapterFor(source, input.value).viewer()
    return c.json({ ok: true, user: viewer })
  } catch (e) {
    const d = describe(e, [input.value.token])
    return c.json({ ok: false, code: d.code, errorMessages: [d.message] }, 400)
  }
})

app.post('/rest/api/2/migration/tools/:source/analyze', ...guards, async (c) => {
  const source = sourceOf(c)
  if (!source) return c.json({ errorMessages: ['Unknown source'] }, 404)
  const input = await readInput(c)
  if (!input.ok) return c.json({ errorMessages: [input.message] }, input.status)
  try {
    const containers = await adapterFor(source, input.value).containers(extractOptions(input.value.options))
    const refs = await db.select({ externalId: schema.migrationExternalRefs.externalId, localId: schema.migrationExternalRefs.localId }).from(schema.migrationExternalRefs)
      .where(and(eq(schema.migrationExternalRefs.source, source), eq(schema.migrationExternalRefs.entityType, 'project')))
    const known = new Set(refs.map((r) => r.externalId))
    const keys = new Set((await db.select({ k: schema.projects.projectKey }).from(schema.projects)).map((p) => p.k))
    const out = containers.slice(0, 5000).map((ct) => {
      const existsInVeqsio = known.has(ct.id)
      // Propose a free key so the admin sees (and can edit) the final key before importing.
      const base = sanitizeKey(ct.suggestedKey, 10)
      let key = base
      if (!existsInVeqsio) {
        for (let n = 2; keys.has(key); n++) key = `${base.slice(0, 10 - String(n).length)}${n}`
        keys.add(key)
      }
      return { ...ct, existsInVeqsio, suggestedKey: key }
    })
    return c.json({ containers: out })
  } catch (e) {
    const d = describe(e, [input.value.token])
    return c.json({ code: d.code, errorMessages: [d.message] }, 400)
  }
})

app.post('/rest/api/2/migration/tools/:source/run', ...guards, async (c) => {
  const user = c.get('user')!
  const source = sourceOf(c)
  if (!source) return c.json({ errorMessages: ['Unknown source'] }, 404)
  const input = await readInput(c)
  if (!input.ok) return c.json({ errorMessages: [input.message] }, input.status)
  const { dryRun, options, token } = input.value

  let adapter
  try { adapter = adapterFor(source, input.value) } catch (e) {
    const d = describe(e, [token])
    return c.json({ code: d.code, errorMessages: [d.message] }, 400)
  }

  if (!dryRun) {
    // One real import per source at a time (a crashed job older than 2 hours does not block).
    const since = new Date(Date.now() - 2 * 3600_000)
    const [busy] = await db.select({ id: schema.migrationSessions.id }).from(schema.migrationSessions)
      .where(and(eq(schema.migrationSessions.status, 'running'), gt(schema.migrationSessions.startedAt, since),
        sql`${schema.migrationSessions.options}->>'toolImport' = 'true'`, sql`${schema.migrationSessions.options}->>'source' = ${source}`,
        sql`${schema.migrationSessions.options}->>'dryRun' = 'false'`)).limit(1)
    if (busy) return c.json({ errorMessages: [`An import from ${SOURCE_INFO[source].name} is already running (session ${busy.id})`], sessionId: busy.id }, 409)
  }

  const { containerIds, workspaceId, groupBy, includeComments, onExisting, userMapping, createMissingUsers, projectKeys, updatedSince, namespace } = options
  const sessionId = await startToolImport({
    source, adapter, userId: user.id, secrets: token ? [token] : [],
    extract: extractOptions(options),
    engine: { dryRun, onExisting, userMapping, createMissingUsers, projectKeys, includeComments },
    storedOptions: { containerIds, workspaceId, groupBy, includeComments, onExisting, createMissingUsers, projectKeys, updatedSince, namespace, userMappingCount: Object.keys(userMapping ?? {}).length },
  })
  return c.json({ sessionId, status: 'running', dryRun }, 202)
})

const sessionView = (s: typeof schema.migrationSessions.$inferSelect) => {
  const o = (s.options ?? {}) as Record<string, any>
  return {
    id: s.id, source: o.source as string, dryRun: !!o.dryRun, status: s.status, startedAt: s.startedAt, completedAt: s.completedAt,
    processed: s.processedEntities ?? 0, total: s.totalEntities ?? 0, errors: (s.errors as string[]) ?? [],
    report: o.report ?? null,
  }
}

app.get('/rest/api/2/migration/tools/sessions', ...guards, async (c) => {
  const rows = await db.select().from(schema.migrationSessions)
    .where(sql`${schema.migrationSessions.options}->>'toolImport' = 'true'`)
    .orderBy(desc(schema.migrationSessions.id)).limit(30)
  // The list omits the (large) reports.
  return c.json({ sessions: rows.map((r) => ({ ...sessionView(r), report: null })) })
})

app.get('/rest/api/2/migration/tools/sessions/:sessionId', ...guards, async (c) => {
  const id = Number(c.req.param('sessionId'))
  const [row] = await db.select().from(schema.migrationSessions).where(eq(schema.migrationSessions.id, id)).limit(1)
  if (!row || (row.options as any)?.toolImport !== true) return c.json({ errorMessages: ['Session not found'] }, 404)
  return c.json({ session: sessionView(row) })
})

app.post('/rest/api/2/migration/tools/sessions/:sessionId/cancel', ...guards, async (c) => {
  const id = Number(c.req.param('sessionId'))
  const [row] = await db.select().from(schema.migrationSessions).where(eq(schema.migrationSessions.id, id)).limit(1)
  if (!row || (row.options as any)?.toolImport !== true) return c.json({ errorMessages: ['Session not found'] }, 404)
  if (row.status !== 'running') return c.json({ errorMessages: [`Session is ${row.status}, not running`] }, 409)
  await cancelMigration(id)
  return c.json({ ok: true, status: 'cancelled' })
})

export default app
