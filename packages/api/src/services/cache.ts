import { getRedisClient } from './redis-client';

const redis = getRedisClient();

export const DEFAULT_TTLS = {
  issue: 300,      // 5 minutes
  search: 60,      // 1 minute
  metadata: 1800,  // 30 minutes
  permission: 1800, // 30 minutes
  project: 600,    // 10 minutes
  default: 300,    // 5 minutes
} as const;

export type CacheTTL = number | keyof typeof DEFAULT_TTLS;

function resolveTTL(ttl?: CacheTTL): number {
  if (ttl === undefined) return DEFAULT_TTLS.default;
  if (typeof ttl === 'number') return ttl;
  return DEFAULT_TTLS[ttl];
}

export async function get<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  } catch {
    return null;
  }
}

export async function set<T>(key: string, value: T, ttl?: CacheTTL): Promise<void> {
  try {
    const seconds = resolveTTL(ttl);
    await redis.setex(key, seconds, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export async function del(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    // ignore
  }
}

export async function delPattern(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // ignore
  }
}

export async function getOrSet<T>(
  key: string,
  factory: () => Promise<T>,
  ttl?: CacheTTL
): Promise<T> {
  try {
    const cached = await get<T>(key);
    if (cached !== null) {
      return cached;
    }
  } catch {
    // ignore
  }
  const value = await factory();
  await set(key, value, ttl);
  return value;
}

/**
 * Cache "generations": instead of finding and deleting every cached search page with KEYS (O(number of keys) and it
 * blocks Redis, on every issue write), writers bump a counter and readers include it in their cache key. Stale
 * entries are simply never read again and expire by TTL. The counter outlives the longest TTL that uses it.
 */
const GEN_TTL_SECONDS = 2 * 3600;

export async function generation(scope: string): Promise<string> {
  try {
    return (await redis.get(`veqsio:gen:${scope}`)) ?? '0';
  } catch {
    return '0';
  }
}

export async function bumpGeneration(scope: string): Promise<void> {
  try {
    await redis.incr(`veqsio:gen:${scope}`);
    await redis.expire(`veqsio:gen:${scope}`, GEN_TTL_SECONDS);
  } catch {
    // best effort: worst case entries live until their TTL
  }
}

export { redis };
