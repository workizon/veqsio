import { Hono } from 'hono'
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { ensureAuditTable, recordAudit } from '../audit/log'
import { toCsv } from '../audit/classify'
import { requireFeature } from '../license'
import { getClientIP } from '../middleware/rate-limit'

const app = new Hono<AppContext>()
const guard = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

const EXPORT_LIMIT = 50_000

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function parseDate(v: string | undefined, endOfDay: boolean): Date | null {
  if (!v) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) && endOfDay ? `${v}T23:59:59.999Z` : v)
  return Number.isNaN(d.getTime()) ? null : d
}

function buildWhere(q: (n: string) => string | undefined): SQL | undefined {
  const conds: SQL[] = []
  const actor = q('actor')
  if (actor) conds.push(ilike(schema.auditLog.actorName, `%${escapeLike(actor)}%`))
  const action = q('action')
  if (action) conds.push(ilike(schema.auditLog.action, `%${escapeLike(action)}%`))
  const targetType = q('targetType')
  if (targetType) conds.push(eq(schema.auditLog.targetType, targetType))
  const text = q('q')
  if (text) {
    const like = `%${escapeLike(text)}%`
    conds.push(or(ilike(schema.auditLog.target, like), ilike(schema.auditLog.path, like), ilike(schema.auditLog.action, like))!)
  }
  const from = parseDate(q('from'), false)
  if (from) conds.push(gte(schema.auditLog.createdAt, from))
  const to = parseDate(q('to'), true)
  if (to) conds.push(lte(schema.auditLog.createdAt, to))
  return conds.length ? and(...conds) : undefined
}

app.get('/rest/api/2/admin/audit', ...guard, async (c) => {
  await ensureAuditTable()
  const where = buildWhere((n) => c.req.query(n))
  const startAt = Math.max(0, Number(c.req.query('startAt')) || 0)
  const maxResults = Math.min(200, Math.max(1, Number(c.req.query('maxResults')) || 50))
  const rows = await db.select().from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id)).limit(maxResults).offset(startAt)
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.auditLog).where(where)
  const types = await db.selectDistinct({ t: schema.auditLog.targetType }).from(schema.auditLog)
  return c.json({ startAt, maxResults, total, targetTypes: types.map((r) => r.t).sort(), entries: rows })
})

app.get('/rest/api/2/admin/audit/export', ...guard, requireFeature('audit_export'), async (c) => {
  await ensureAuditTable()
  const where = buildWhere((n) => c.req.query(n))
  const rows = await db.select().from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id)).limit(EXPORT_LIMIT)
  const csv = toCsv(
    ['id', 'timestamp', 'actor', 'actor_id', 'action', 'target_type', 'target', 'method', 'path', 'status', 'ip', 'details'],
    rows.map((r) => [r.id, r.createdAt, r.actorName, r.actorId, r.action, r.targetType, r.target, r.method, r.path, r.status, r.ip, r.details]),
  )
  const user = c.get('user')
  void recordAudit({
    actorId: user?.id, actorName: user?.username, action: 'AUDIT_LOG_EXPORTED', targetType: 'audit_log',
    target: String(rows.length), method: 'GET', path: c.req.path, status: 200,
    ip: ((ip) => (ip === 'unknown' ? null : ip))(getClientIP(c)),
  })
  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
})

export default app
