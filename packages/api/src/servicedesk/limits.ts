import { redis } from '../services/cache'
import { getDeskRole, isStaff } from './service'

/**
 * Abuse limits for the customer portal. Limits are read from the environment at
 * call time (not import time) so they can be tuned without a rebuild and in tests.
 */

export const HOUR_MS = 3_600_000

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export const maxRequestsPerHour = () => envInt('PORTAL_MAX_REQUESTS_PER_HOUR', 20)
export const maxCommentsPerHour = () => envInt('PORTAL_MAX_COMMENTS_PER_HOUR', 60)
export const maxUploadsPerHour = () => envInt('PORTAL_MAX_UPLOADS_PER_HOUR', 60)

export interface LimitResult { allowed: boolean; retryAfter: number }

/**
 * Sliding-window counter (sorted set of timestamps). The entry is added first and
 * removed again when over the limit, so concurrent requests cannot slip past.
 * Fails open if the store is unreachable: a Redis outage must not take the portal down.
 */
export async function consumeLimit(key: string, max: number, windowMs = HOUR_MS): Promise<LimitResult> {
  const fullKey = `veqsio:portal-limit:${key}`
  const now = Date.now()
  const member = `${now}-${Math.random().toString(36).slice(2)}`
  try {
    const res = await redis.pipeline()
      .zremrangebyscore(fullKey, 0, now - windowMs)
      .zadd(fullKey, now, member)
      .zcard(fullKey)
      .pexpire(fullKey, windowMs)
      .exec()
    const count = Number(res?.[2]?.[1] ?? 0)
    if (count <= max) return { allowed: true, retryAfter: 0 }
    await redis.zrem(fullKey, member)
    const oldest = await redis.zrange(fullKey, 0, 0, 'WITHSCORES')
    const oldestTs = oldest.length > 1 ? Number(oldest[1]) : now
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((oldestTs + windowMs - now) / 1000)) }
  } catch (err) {
    console.error('[portal-limits] store unavailable, failing open', err)
    return { allowed: true, retryAfter: 0 }
  }
}

function tooMany(c: any, retryAfter: number): Response {
  c.header('Retry-After', String(retryAfter))
  return c.json({ errorMessages: ['Too many requests. Please try again later.'] }, 429)
}

type Desk = { id: number; projectId: number }

/** Returns a 429 Response when the caller is over the limit, otherwise null. */
async function enforce(c: any, bucket: string, desk: Desk, max: number, exemptStaff: boolean): Promise<Response | null> {
  const user = c.get('user')
  if (!user) return null
  if (exemptStaff && isStaff(await getDeskRole(user, desk as any))) return null
  const r = await consumeLimit(`${bucket}:${desk.id}:${user.id}`, max)
  return r.allowed ? null : tooMany(c, r.retryAfter)
}

/** New requests per user per hour per desk. */
export const portalRequestLimit = (c: any, desk: Desk) => enforce(c, 'req', desk, maxRequestsPerHour(), false)
/** Comments per user per hour per desk; staff are exempt. */
export const portalCommentLimit = (c: any, desk: Desk) => enforce(c, 'cmt', desk, maxCommentsPerHour(), true)
/** Attachment uploads per user per hour per desk; staff are exempt. */
export const portalUploadLimit = (c: any, desk: Desk) => enforce(c, 'upl', desk, maxUploadsPerHour(), true)
