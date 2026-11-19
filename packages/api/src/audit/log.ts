import type { MiddlewareHandler } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import type { AppContext } from '../auth/middleware'
import { classifyRequest } from './classify'
import { getClientIP } from '../middleware/rate-limit'

/**
 * Admin audit log.
 *
 * `auditMiddleware` is mounted once in app.ts. After a request finishes it checks whether the
 * route is an admin action (see classify.ts) and, if the request succeeded, writes one row:
 * actor, action, target, timestamp, IP. New admin routes only need a rule in classify.ts.
 *
 * Never recorded: request/response bodies, headers, query strings. Only the names of the JSON
 * body fields that were sent are kept, which shows what was changed without exposing values
 * such as passwords, client secrets or SMTP credentials.
 */

export interface AuditEntry {
  actorId?: number | null
  actorName?: string | null
  action: string
  targetType: string
  target?: string | null
  method?: string | null
  path?: string | null
  status?: number | null
  ip?: string | null
  details?: Record<string, unknown> | null
}

let tableReady: Promise<void> | null = null

/** The audit table has no drizzle migration yet, so create it idempotently on first use. */
export function ensureAuditTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS audit_log (
        id bigserial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        actor_id integer,
        actor_name varchar(255),
        action varchar(100) NOT NULL,
        target_type varchar(50) NOT NULL,
        target varchar(255),
        method varchar(10),
        path varchar(500),
        status integer,
        ip varchar(64),
        details jsonb
      )`)
      await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at)`)
      await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action)`)
      await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_name)`)
    })().catch((err) => {
      tableReady = null
      throw err
    })
  }
  return tableReady
}

/** Best effort: an audit write failure must never break the admin action itself. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await ensureAuditTable()
    await db.insert(schema.auditLog).values({
      actorId: entry.actorId ?? null,
      actorName: entry.actorName?.slice(0, 255) ?? null,
      action: entry.action.slice(0, 100),
      targetType: entry.targetType.slice(0, 50),
      target: entry.target?.slice(0, 255) ?? null,
      method: entry.method ?? null,
      path: entry.path?.slice(0, 500) ?? null,
      status: entry.status ?? null,
      ip: entry.ip?.slice(0, 64) ?? null,
      details: entry.details ?? null,
    })
  } catch (err) {
    console.error('[audit] failed to record entry', (err as Error).message)
  }
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const ip = getClientIP(c)
  return ip === 'unknown' ? null : ip
}

/** Body keys whose values are plain identifiers (never secrets) and may be used as the target. */
const IDENT_KEYS = ['username', 'groupName', 'groupname', 'name', 'key', 'projectKey']

/** Names (never values) of the top-level JSON fields, plus one identifier value from a fixed allowlist. */
async function bodyInfo(c: Parameters<MiddlewareHandler<AppContext>>[0]): Promise<{ fields?: string[]; ident?: string }> {
  const type = c.req.header('content-type') || ''
  if (!type.includes('application/json')) return {}
  try {
    const body = await c.req.raw.clone().json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const k = IDENT_KEYS.find((key) => typeof (body as any)[key] === 'string' && (body as any)[key])
      return { fields: Object.keys(body).slice(0, 50), ident: k ? String((body as any)[k]).replace(/[\r\n\t]+/g, ' ').slice(0, 255) : undefined }
    }
  } catch { /* unreadable body: record nothing */ }
  return {}
}

export const auditMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const hit = classifyRequest(c.req.method, c.req.path, (n) => c.req.query(n))
  if (!hit) return next()
  const info = await bodyInfo(c)
  await next()
  const status = c.res.status
  if (status >= 400) return
  const user = c.get('user')
  // Fire and forget; recordAudit swallows its own errors.
  void recordAudit({
    actorId: user?.id ?? null,
    actorName: user?.username ?? null,
    action: hit.action,
    targetType: hit.targetType,
    target: hit.target ?? info.ident ?? null,
    method: c.req.method,
    path: c.req.path,
    status,
    ip: clientIp(c),
    details: info.fields ? { fields: info.fields } : null,
  })
}
