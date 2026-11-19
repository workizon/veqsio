import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { parseCsv, suggestMapping, TARGET_FIELDS, MAX_CSV_BYTES } from '../migration/csv/parse'
import { runCsvImport } from '../migration/csv/importer'
import { invalidateIssueCache } from '../middleware/cache'

/**
 * Wizard-style CSV import (Jira CSV export compatible):
 *   1. POST /preview -> headers, sample rows, suggested column mapping
 *   2. POST /run with dryRun=true -> validation report, nothing written
 *   3. POST /run with dryRun=false -> import
 */
const app = new Hono<AppContext>()

const csvText = z.string().min(1).max(MAX_CSV_BYTES)

const previewBody = z.object({ csv: csvText }).strict()

const mappingSchema = z.object(
  Object.fromEntries(TARGET_FIELDS.map((f) => [f, z.array(z.number().int().min(0).max(1000)).max(50).optional()])) as Record<(typeof TARGET_FIELDS)[number], z.ZodOptional<z.ZodArray<z.ZodNumber>>>,
).strict()

const runBody = z.object({
  csv: csvText,
  projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(50),
  mapping: mappingSchema,
  dateOrder: z.enum(['dmy', 'mdy']).optional(),
  dryRun: z.boolean().default(true),
  defaultIssueType: z.string().min(1).max(100).optional(),
  onExisting: z.enum(['skip', 'overwrite']).optional(),
  userMapping: z.record(z.string().max(255)).optional(),
  createMissingUsers: z.boolean().optional(),
}).strict()

app.post('/rest/api/2/csv-import/preview', requireAuth, zValidator('json', previewBody), async (c) => {
  try {
    const parsed = parseCsv(c.req.valid('json').csv)
    return c.json({
      headers: parsed.headers,
      sample: parsed.rows.slice(0, 5),
      rowCount: parsed.rows.length,
      suggestedMapping: suggestMapping(parsed.headers),
      targetFields: TARGET_FIELDS,
    })
  } catch (e: any) {
    return c.json({ errorMessages: [e.message] }, 400)
  }
})

app.post('/rest/api/2/csv-import/run', requireAuth, zValidator('json', runBody), async (c) => {
  const user = c.get('user')!
  const body = c.req.valid('json')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, body.projectKey)).limit(1)
  // Bulk import can set reporters and dates, so it needs project administration rights.
  if (!project || !(await checkProjectPermission(user, project.id, 'ADMINISTER_PROJECTS'))) {
    return c.json({ errorMessages: ['Project not found'] }, 404)
  }
  try {
    const { csv, ...opts } = body
    const report = await runCsvImport(parseCsv(csv), opts, user.id)
    if (!report.dryRun) await invalidateIssueCache()
    return c.json(report)
  } catch (e: any) {
    return c.json({ errorMessages: [e.message] }, 400)
  }
})

export default app
