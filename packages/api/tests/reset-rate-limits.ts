import { redis } from '../src/services/cache';

/**
 * The in-memory limiter outlives table truncation and user ids repeat across test files: start clean.
 * (The memory store's `keys()` does not list sorted sets, so the keys are deleted explicitly.)
 */
export async function resetRateLimits() {
  const keys = ['veqsio:ratelimit:ip:unknown'];
  for (let id = 1; id <= 50; id++) keys.push(`veqsio:ratelimit:user:${id}`);
  await redis.del(...keys);
}
