import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';
import { redis } from '../services/cache';
import { INTERNAL_HEADER, isInternalRequest } from './internal-request';

const WINDOW_SIZE_MS = 60_000; // 1 minute

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

// Defaults: 100 requests/min per user, 1000/min per IP. Both can be raised for load tests or large NATed
// offices with RATE_LIMIT_USER_MAX / RATE_LIMIT_IP_MAX (read at request time).
const defaultConfig: RateLimitConfig = {
  // Per-user requests per minute; override with RATE_LIMIT_USER_MAX (the integration suite raises it).
  maxRequests: Number(process.env.RATE_LIMIT_USER_MAX) || 100,
  windowMs: WINDOW_SIZE_MS,
};

const envInt = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};
const ipLimit = () => ({ maxRequests: envInt('RATE_LIMIT_IP_MAX', 1000), windowMs: WINDOW_SIZE_MS });

/**
 * The caller's address behind a reverse proxy. A proxy appends the address it saw to X-Forwarded-For, so the entry
 * to trust is the one added by OUR proxy: `TRUSTED_PROXY_HOPS` (default 1) entries from the right. Taking the first
 * entry (the old behaviour) let any client choose its own rate-limit bucket by sending the header. Without a proxy
 * set TRUSTED_PROXY_HOPS=0 to ignore the header altogether.
 */
export function getClientIP(c: any): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded && hops > 0) {
    const parts = forwarded.split(',').map((p: string) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[Math.max(0, parts.length - hops)].slice(0, 64);
  }
  return (hops > 0 ? c.req.header('x-real-ip') : undefined) || 'unknown';
}

function buildKey(prefix: string, identifier: string): string {
  return `veqsio:ratelimit:${prefix}:${identifier}`;
}

export async function isAllowed(key: string, config: RateLimitConfig): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Remove expired entries, add current request, count remaining
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zcard(key);
  pipeline.pexpire(key, config.windowMs);

  const results = await pipeline.exec();
  if (!results) {
    return { allowed: true, retryAfter: 0 };
  }

  const count = (results[2]?.[1] as number) ?? 0;

  if (count > config.maxRequests) {
    // Remove the request we just added since it exceeded the limit
    await redis.zremrangebyscore(key, now, now);
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const oldestTimestamp = oldest.length > 1 ? Number(oldest[1]) : now - config.windowMs;
    const retryAfter = Math.ceil((oldestTimestamp + config.windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  return { allowed: true, retryAfter: 0 };
}

export function rateLimitMiddleware(userConfig?: Partial<RateLimitConfig>) {
  const base = { ...defaultConfig, ...userConfig };

  return createMiddleware<AppContext>(async (c, next) => {
    if (isInternalRequest(c.req.header(INTERNAL_HEADER))) return next(); // in-process replay made by a bulk operation
    const user = c.get('user');
    const userId = user?.id;
    const config = userConfig?.maxRequests ? base : { ...base, maxRequests: envInt('RATE_LIMIT_USER_MAX', base.maxRequests) };

    // User-based rate limiting (stricter)
    if (userId) {
      const userKey = buildKey('user', String(userId));
      const userResult = await isAllowed(userKey, config);
      if (!userResult.allowed) {
        c.header('Retry-After', String(userResult.retryAfter));
        return c.json({ errorMessages: [`Rate limit exceeded. Retry after ${userResult.retryAfter} seconds.`] }, 429);
      }
    }

    // IP-based rate limiting (more lenient)
    const ip = getClientIP(c);
    const ipKey = buildKey('ip', ip);
    const ipResult = await isAllowed(ipKey, ipLimit());
    if (!ipResult.allowed) {
      c.header('Retry-After', String(ipResult.retryAfter));
      return c.json({ errorMessages: [`Rate limit exceeded. Retry after ${ipResult.retryAfter} seconds.`] }, 429);
    }

    await next();
  });
}
