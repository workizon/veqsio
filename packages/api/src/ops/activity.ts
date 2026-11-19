import { redis } from '../services/cache';

const KEY = 'veqsio:ops:active-users';
const WINDOW_MS = 15 * 60_000;
const lastWrite = new Map<number, number>();

/** Records that a user made an authenticated request. Writes to Redis at most once a minute per user and node. */
export function touchActiveUser(userId: number, now = Date.now()): void {
  const prev = lastWrite.get(userId);
  if (prev && now - prev < 60_000) return;
  lastWrite.set(userId, now);
  if (lastWrite.size > 5000) lastWrite.clear();
  Promise.resolve().then(() => redis.zadd(KEY, now, String(userId))).catch(() => {});
}

/** Distinct users seen on any node in the last 15 minutes. */
export async function countActiveUsers(now = Date.now()): Promise<number> {
  await redis.zremrangebyscore(KEY, 0, now - WINDOW_MS);
  return Number(await redis.zcard(KEY));
}
