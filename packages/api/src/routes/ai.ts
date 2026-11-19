import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { loadSettings, publicFeatures, saveSettings, settingsInput, toAdminView } from '../ai/config'
import { usageSummary } from '../ai/limits'
import {
  AiHttpError, draftAutomationRule, draftPostIncidentReview, draftReleaseNotes, similarForDraft, similarForIssue, suggestTriage, summarizeIssue, testConnection,
} from '../ai/service'

const app = new Hono<AppContext>()

/** Runs a handler, mapping AiHttpError to a JSON error. AI responses are per-user and must never be cached. */
async function guarded(c: any, fn: () => Promise<unknown>) {
  c.header('Cache-Control', 'no-store')
  try {
    return c.json(await fn())
  } catch (err) {
    if (err instanceof AiHttpError) {
      if (err.retryAfter) c.header('Retry-After', String(err.retryAfter))
      return c.json({ errorMessages: [err.message] }, err.status)
    }
    throw err
  }
}

/* ---------------------------- Public feature flags ---------------------------- */

app.get('/rest/api/2/ai/features', requireAuth, async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(publicFeatures(await loadSettings()))
})

/* --------------------------------- Admin --------------------------------- */

app.get('/rest/api/2/admin/ai', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ ...toAdminView(await loadSettings()), usage: await usageSummary(7) })
})

app.put('/rest/api/2/admin/ai', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', settingsInput), async (c) => {
  c.header('Cache-Control', 'no-store')
  const res = await saveSettings(c.req.valid('json'))
  if (!res.ok) return c.json({ errorMessages: [res.error] }, 400)
  return c.json(toAdminView(res.settings))
})

app.post('/rest/api/2/admin/ai/test', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(await testConnection(await loadSettings()))
})

/* ---------------------------------- Features ---------------------------------- */

const draftBody = z.object({
  projectId: z.number().int().positive(),
  summary: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable().optional(),
}).strict()

app.post('/rest/api/2/issue/similar', requireAuth, zValidator('json', draftBody), (c) =>
  guarded(c, () => similarForDraft(c.get('user')!, c.req.valid('json'))))

app.post('/rest/api/2/issue/ai/suggest', requireAuth, zValidator('json', draftBody), (c) =>
  guarded(c, () => suggestTriage(c.get('user')!, c.req.valid('json'))))

app.get('/rest/api/2/issue/:key/similar', requireAuth, (c) =>
  guarded(c, () => similarForIssue(c.get('user')!, c.req.param('key'))))

app.post('/rest/api/2/issue/:key/ai/summarize', requireAuth, (c) =>
  guarded(c, () => summarizeIssue(c.get('user')!, c.req.param('key'))))

app.post('/rest/api/2/issue/:key/ai/post-incident-review', requireAuth, (c) =>
  guarded(c, () => draftPostIncidentReview(c.get('user')!, c.req.param('key'))))

app.post('/rest/api/2/automation/ai/draft', requireAuth,
  zValidator('json', z.object({ description: z.string().trim().min(5).max(2000) }).strict()),
  (c) => guarded(c, () => draftAutomationRule(c.get('user')!, c.req.valid('json').description)))

app.post('/rest/api/2/project/:key/ai/release-notes', requireAuth,
  zValidator('json', z.object({ versionId: z.number().int().positive() }).strict()),
  (c) => guarded(c, () => draftReleaseNotes(c.get('user')!, c.req.param('key'), c.req.valid('json').versionId)))

export default app
