import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';
import * as cache from '../services/cache';

/** Which generation counter governs a cached GET, if any. */
function cacheScope(pathname: string): string | null {
  const m = /^\/rest\/api\/2\/issue\/([^/]+)/.exec(pathname);
  if (m) return `issue:${decodeURIComponent(m[1])}`;
  if (pathname === '/rest/api/2/issue' || pathname.startsWith('/rest/api/2/search')) return 'search';
  return null;
}

export function cacheMiddleware(ttlSeconds: number) {
  return createMiddleware<AppContext>(async (c, next) => {
    const method = c.req.method;
    const url = new URL(c.req.url);

    // Skip cache for non-GET methods
    if (method !== 'GET') {
      await next();
      return;
    }

    // Skip cache when ?nocache=1
    if (url.searchParams.get('nocache') === '1') {
      await next();
      return;
    }

    const user = c.get('user');
    const userId = user?.id ?? 'anon';
    // Issue and search responses are versioned by a generation counter (see services/cache.ts) so a write
    // invalidates them with one INCR instead of a KEYS scan.
    const scope = cacheScope(url.pathname);
    // `security` is bumped whenever issue security members, levels or associations change (visibility changes for many issues at once).
    const gen = scope ? `g${await cache.generation(scope)}.${await cache.generation('security')}:` : '';
    const cacheKey = `veqsio:cache:${userId}:${gen}${url.pathname}${url.search}`;

    // Entries are stored as the already-serialised JSON text, so a hit is returned as-is (no JSON.parse +
    // JSON.stringify round trip, which dominated CPU for 50-issue search pages).
    let cachedRaw: string | null = null;
    try {
      cachedRaw = await cache.redis.get(cacheKey);
    } catch {
      cachedRaw = null;
    }
    if (cachedRaw) {
      return c.body(cachedRaw, 200, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': `max-age=${ttlSeconds}, private`,
        'X-Cache': 'HIT',
      });
    }

    await next();

    // Only cache successful JSON responses
    if (c.res.status >= 200 && c.res.status < 300) {
      c.header('Cache-Control', `max-age=${ttlSeconds}, private`);
      c.header('X-Cache', 'MISS');
      try {
        if ((c.res.headers.get('content-type') || '').includes('application/json')) {
          const text = await c.res.clone().text();
          await cache.redis.setex(cacheKey, ttlSeconds, text);
        }
      } catch {
        // caching is best effort
      }
    }
  });
}

export async function invalidateCache(pattern: string): Promise<void> {
  await cache.delPattern(pattern);
}

export async function invalidateIssueCache(issueKey?: string): Promise<void> {
  if (issueKey) await cache.bumpGeneration(`issue:${issueKey}`);
  await cache.bumpGeneration('search');
}

export async function invalidateProjectCache(projectKey?: string): Promise<void> {
  if (projectKey) {
    await cache.delPattern(`veqsio:cache:*:/rest/api/2/project/${projectKey}*`);
  }
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/project*`);
}

export async function invalidateMetadataCache(): Promise<void> {
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/issuetype*`);
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/status*`);
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/priority*`);
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/field*`);
  await cache.delPattern(`veqsio:cache:*:/rest/api/2/resolution*`);
}
