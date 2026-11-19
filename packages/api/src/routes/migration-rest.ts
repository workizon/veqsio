import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { JiraClient, normalizeBaseUrl, type JiraAuth } from '../migration/rest/client'
import { runRestImport, type RestImportOptions } from '../migration/rest/importer'
import { importServiceDesks } from '../migration/rest/jsm'
import { planFromDb } from '../migration/rest/fieldsync'
import { previewPeople } from '../migration/rest/people'
import { Resolver } from '../migration/resolver'
import type { JiraFieldMeta } from '../migration/rest/customfields'

/**
 * Import from a live Jira (Cloud or Server/Data Center) over REST.
 * Credentials are used for the duration of the request / background job and are never persisted.
 */
const app = new Hono<AppContext>()

const connection = z.object({
  baseUrl: z.string().url().max(500),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('basic'), username: z.string().min(1).max(255), secret: z.string().min(1).max(2000) }).strict(),
    z.object({ type: z.literal('bearer'), token: z.string().min(1).max(4000) }).strict(),
  ]),
}).strict()

const runBody = connection.extend({
  options: z.object({
    projectKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).min(1).max(200),
    includeAttachments: z.boolean().optional(),
    includeHistory: z.boolean().optional(),
    includeAgile: z.boolean().optional(),
    includeCustomFields: z.boolean().optional(),
    includeWorkflows: z.boolean().optional(),
    includeSchemes: z.boolean().optional(),
    includePeople: z.boolean().optional(),
    includeConfig: z.boolean().optional(),
    includeScreens: z.boolean().optional(),
    includeAvatars: z.boolean().optional(),
    fieldOverrides: z.record(z.string().regex(/^customfield_\d+$/), z.object({ action: z.enum(['create', 'map', 'skip']), localId: z.number().int().positive().optional() }).strict()).optional(),
    updatedSince: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/).optional(),
    onExisting: z.enum(['skip', 'overwrite']).optional(),
    userMapping: z.record(z.string().max(255)).optional(),
    createMissingUsers: z.boolean().optional(),
  }).strict(),
}).strict()

const guards = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

function makeClient(body: z.infer<typeof connection>) {
  return new JiraClient({ baseUrl: body.baseUrl, auth: body.auth as JiraAuth })
}

// Never echo upstream error bodies/credentials: map to a short message.
function describe(e: unknown): string {
  const m = e instanceof Error ? e.message : 'Unknown error'
  return m.replace(/Basic [A-Za-z0-9+/=]+|Bearer \S+/g, '[redacted]').slice(0, 300)
}

app.post('/rest/api/2/migration/rest/test', ...guards, zValidator('json', connection), async (c) => {
  try {
    const client = makeClient(c.req.valid('json'))
    const me = await client.myself()
    return c.json({ ok: true, baseUrl: client.baseUrl, user: { displayName: me.displayName, emailAddress: me.emailAddress } })
  } catch (e) {
    return c.json({ ok: false, errorMessages: [describe(e)] }, 400)
  }
})

app.post('/rest/api/2/migration/rest/analyze', ...guards, zValidator('json', connection), async (c) => {
  try {
    const client = makeClient(c.req.valid('json'))
    const projects = await client.projects()
    const existing = new Set((await db.select({ k: schema.projects.projectKey }).from(schema.projects)).map((p) => p.k))
    const out = []
    for (const p of projects.slice(0, 500)) {
      out.push({
        key: p.key, name: p.name, lead: p.lead?.displayName ?? null,
        issueCount: await client.countIssues(`project = "${String(p.key).replace(/[^A-Za-z0-9_]/g, '')}"`),
        existsInVeqsio: existing.has(p.key),
      })
    }
    return c.json({ projects: out })
  } catch (e) {
    return c.json({ errorMessages: [describe(e)] }, 400)
  }
})

/**
 * What would happen to each Jira custom field: created, matched to a field that is already here (by the Jira id remembered from an
 * earlier import, else by name and type) or skipped, and why. The same planner the import uses, so the preview is what will happen.
 */
app.post('/rest/api/2/migration/rest/fields/preview', ...guards, zValidator('json', connection.extend({
  fieldOverrides: runBody.shape.options.shape.fieldOverrides,
}).strict()), async (c) => {
  try {
    const body = c.req.valid('json')
    const client = makeClient(body)
    const metas = await client.get<JiraFieldMeta[]>('/rest/api/2/field')
    const rows = await planFromDb(metas.filter((f) => f.custom), body.fieldOverrides ?? {})
    const existing = await db.select({ id: schema.customFields.id, name: schema.customFields.name, fieldType: schema.customFields.fieldType }).from(schema.customFields).orderBy(schema.customFields.name)
    return c.json({ fields: rows, existing })
  } catch (e) {
    return c.json({ errorMessages: [describe(e)] }, 400)
  }
})

/** What the people import would do: who is matched to an account that exists, who would be created, which groups. Nothing is written. */
app.post('/rest/api/2/migration/rest/people/preview', ...guards, zValidator('json', connection), async (c) => {
  try {
    return c.json(await previewPeople(makeClient(c.req.valid('json')), new Resolver(db)))
  } catch (e) {
    return c.json({ errorMessages: [describe(e)] }, 400)
  }
})

app.post('/rest/api/2/migration/rest/run', ...guards, zValidator('json', runBody), async (c) => {
  const user = c.get('user')!
  const body = c.req.valid('json')
  let client: JiraClient
  try {
    normalizeBaseUrl(body.baseUrl)
    client = makeClient(body)
  } catch (e) {
    return c.json({ errorMessages: [describe(e)] }, 400)
  }

  const options: RestImportOptions = body.options
  const [session] = await db.insert(schema.migrationSessions).values({
    status: 'running',
    backupPath: `jira-rest:${new URL(client.baseUrl).host}`,
    options: { source: 'rest', ...options }, // credentials intentionally excluded
    createdBy: user.id,
  }).returning()

  // Fire and forget; progress/result are written to the session row.
  void (async () => {
    try {
      const report = await runRestImport(client, options, user.id, async (p) => {
        await db.update(schema.migrationSessions)
          .set({ totalEntities: p.total, processedEntities: p.processed })
          .where(eq(schema.migrationSessions.id, session.id))
      })
      await db.update(schema.migrationSessions).set({
        status: report.errors.length ? 'completed_with_errors' : 'completed',
        completedAt: new Date(),
        errors: report.errors.slice(0, 500),
        options: { source: 'rest', ...options, report },
      }).where(eq(schema.migrationSessions.id, session.id))
    } catch (e) {
      await db.update(schema.migrationSessions).set({
        status: 'failed', completedAt: new Date(), errors: [describe(e)],
      }).where(eq(schema.migrationSessions.id, session.id))
    }
  })()

  return c.json({ sessionId: session.id, status: 'running' }, 202)
})

/**
 * Jira Service Management: desks, request types with forms, groups, queues, organizations and their customers.
 * Run the normal Jira import for the project first. `analyze` lists the desks and whether their project is already here.
 */
app.post('/rest/api/2/migration/rest/jsm/analyze', ...guards, zValidator('json', connection), async (c) => {
  try {
    const client = makeClient(c.req.valid('json'))
    const res = await client.get('/rest/servicedeskapi/servicedesk', { limit: 100 })
    const existing = new Set((await db.select({ k: schema.projects.projectKey }).from(schema.projects)).map((p) => p.k))
    const hasDesk = new Set((await db.select({ id: schema.serviceDesks.projectId }).from(schema.serviceDesks)).map((d) => d.id))
    const projects = await db.select({ id: schema.projects.id, k: schema.projects.projectKey }).from(schema.projects)
    const withDesk = new Set(projects.filter((p) => hasDesk.has(p.id)).map((p) => p.k))
    return c.json({
      desks: (Array.isArray(res?.values) ? res.values : []).slice(0, 200).map((d: any) => ({
        id: d.id, projectKey: d.projectKey, projectName: d.projectName,
        projectInVeqsio: existing.has(String(d.projectKey).toUpperCase()) || existing.has(String(d.projectKey)),
        deskInVeqsio: withDesk.has(String(d.projectKey)),
      })),
    })
  } catch (e) {
    return c.json({ errorMessages: [describe(e)] }, 400)
  }
})

const jsmBody = connection.extend({
  options: z.object({
    projectKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(200).optional(),
    userMapping: z.record(z.string().max(255)).optional(),
    createMissingUsers: z.boolean().optional(),
  }).strict().default({}),
}).strict()

app.post('/rest/api/2/migration/rest/jsm/run', ...guards, zValidator('json', jsmBody), async (c) => {
  let client: JiraClient
  const body = c.req.valid('json')
  try { client = makeClient(body) } catch (e) { return c.json({ errorMessages: [describe(e)] }, 400) }
  const report = await importServiceDesks(client, body.options)
  await db.insert(schema.migrationSessions).values({
    status: report.errors.length ? 'completed_with_errors' : 'completed',
    backupPath: `jsm-rest:${new URL(client.baseUrl).host}`,
    options: { source: 'jsm', projectKeys: body.options.projectKeys ?? [], report }, // credentials intentionally excluded
    createdBy: c.get('user')!.id, completedAt: new Date(),
  })
  return c.json(report)
})

export default app
