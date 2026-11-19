import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { eq, sql } from 'drizzle-orm'
import { requireAuth } from '../auth/middleware'
import type { AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { currentLevel, recentLogs, runtimeLevelState, scrubString, setRuntimeLevel, type Level } from '../ops/logger'
import { getInstanceSettings, projectQuotaMb } from '../settings/instance'

/** Operations for administrators: the application log of this node, its level, the slowest queries, and storage quotas. */
const app = new Hono<AppContext>()
const guard = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

app.get('/rest/api/2/admin/system/logs', ...guard, (c) => {
  const level = c.req.query('level')
  const q = (c.req.query('q') ?? '').slice(0, 200)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 1000)
  const before = c.req.query('before') || undefined
  const rt = runtimeLevelState()
  return c.json({
    records: recentLogs({ level: (LEVELS as readonly string[]).includes(level ?? '') ? (level as Level) : undefined, q: q || undefined, limit, before }),
    level: { effective: currentLevel(), fromEnvironment: (process.env.LOG_LEVEL || 'info').toLowerCase(), temporary: rt ? { level: rt.level, expiresAt: new Date(rt.expiresAt).toISOString() } : null },
    note: 'Records of this node since it started (the last 2000, secrets and e-mail addresses masked). With several nodes, open each one or use the log collector.',
  })
})

app.put('/rest/api/2/admin/system/log-level', ...guard, zValidator('json', z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).nullable(),
  minutes: z.number().int().min(1).max(1440).optional(),
}).strict()), (c) => {
  const { level, minutes } = c.req.valid('json')
  const st = setRuntimeLevel(level, minutes ?? 60)
  return c.json({ effective: currentLevel(), temporary: st ? { level: st.level, expiresAt: new Date(st.expiresAt).toISOString() } : null })
})

/**
 * The slowest statements, from the pg_stat_statements extension. It has to be loaded by the database server
 * (shared_preload_libraries = 'pg_stat_statements'); until it is, the answer says how. Statement texts come with their parameters
 * already replaced by $1, $2 and are scrubbed again here.
 */
app.get('/rest/api/2/admin/system/slow-queries', ...guard, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 25, 1), 100)
  const order = c.req.query('by') === 'total' ? 'total_exec_time' : 'mean_exec_time'
  try {
    const rows = await db.execute(sql.raw(`SELECT query, calls::bigint AS calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms, round(total_exec_time::numeric, 0) AS total_ms, rows::bigint AS rows FROM pg_stat_statements WHERE calls >= 3 AND query NOT ILIKE '%pg_stat_statements%' ORDER BY ${order} DESC LIMIT ${limit}`)) as unknown as Array<Record<string, any>>
    return c.json({
      enabled: true,
      statements: rows.map((r) => ({ query: scrubString(String(r.query)).slice(0, 1500), calls: Number(r.calls), meanMs: Number(r.mean_ms), maxMs: Number(r.max_ms), totalMs: Number(r.total_ms), rows: Number(r.rows) })),
    })
  } catch {
    return c.json({
      enabled: false,
      howTo: "Load the extension in the database server: start PostgreSQL with `-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all` (and optionally `-c log_min_duration_statement=500` to log every statement slower than 500 ms), restart it, then run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` once. See docs/performance.md.",
      statements: [],
    })
  }
})

/** Attachment quota of one project in MB; null removes its own limit (the instance-wide one applies again). */
app.put('/rest/api/2/admin/system/storage/quota/:key', ...guard, zValidator('json', z.object({ quotaMb: z.number().int().min(0).max(100000000).nullable() }).strict()), async (c) => {
  const key = c.req.param('key')
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404)
  const { quotaMb } = c.req.valid('json')
  const settingKey = `storage.quota.${key}`
  if (quotaMb === null) await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, settingKey))
  else {
    const [e] = await db.select({ id: schema.systemSettings.id }).from(schema.systemSettings).where(eq(schema.systemSettings.key, settingKey)).limit(1)
    if (e) await db.update(schema.systemSettings).set({ value: String(quotaMb), updatedAt: new Date() }).where(eq(schema.systemSettings.id, e.id))
    else await db.insert(schema.systemSettings).values({ key: settingKey, value: String(quotaMb) })
  }
  const s = await getInstanceSettings()
  return c.json({ key, quotaMb: await projectQuotaMb(p.id, s.attachmentProjectQuotaMb as number), own: quotaMb })
})

export default app
