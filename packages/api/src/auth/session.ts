import { getRedisClient } from '../services/redis-client';
import { randomUUID } from 'crypto';
import { sessionPolicy } from '../settings/instance';

const SESSION_PREFIX = 'veqsio:session:';
const REVOKED_PREFIX = 'veqsio:session-revoked:';
const SESSION_TTL = 30 * 24 * 60 * 60; // longest possible session; the administrator-chosen idle time is applied below

const redis = getRedisClient();

export interface SessionData {
  userId: number;
  createdAt: string;
}

export async function createSession(userId: number): Promise<string> {
  const sessionId = randomUUID();
  const data: SessionData = { userId, createdAt: new Date().toISOString() };
  const { idleSeconds } = await sessionPolicy();
  await redis.setex(`${SESSION_PREFIX}${sessionId}`, Math.min(idleSeconds, SESSION_TTL), JSON.stringify(data));
  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await redis.get(`${SESSION_PREFIX}${sessionId}`);
  if (!raw) return null;
  const data = JSON.parse(raw) as SessionData;
  // Absolute lifetime (instance setting, 0 = none): the session ends even if it is in use.
  const { maxMs } = await sessionPolicy();
  if (maxMs > 0 && Date.now() - Date.parse(data.createdAt) > maxMs) {
    await redis.del(`${SESSION_PREFIX}${sessionId}`);
    return null;
  }
  // Sessions created before a per-user revocation (deactivation, SCIM) are dead.
  const revoked = await redis.get(`${REVOKED_PREFIX}${data.userId}`);
  if (revoked && Date.parse(data.createdAt) <= Number(revoked)) {
    await redis.del(`${SESSION_PREFIX}${sessionId}`);
    return null;
  }
  return data;
}

export async function refreshSession(sessionId: string): Promise<void> {
  const { idleSeconds } = await sessionPolicy();
  await redis.expire(`${SESSION_PREFIX}${sessionId}`, Math.min(idleSeconds, SESSION_TTL));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
}

/**
 * Invalidate every existing session of a user. Deletes known session keys (returning how many) and also sets a
 * "revoked before" marker that getSession() checks, so sessions created on other instances or missed by the scan
 * are invalidated too; the marker expires with the longest session.
 */
export async function deleteAllUserSessions(userId: number): Promise<number> {
  await redis.setex(`${REVOKED_PREFIX}${userId}`, SESSION_TTL, String(Date.now()));
  const keys: string[] = await redis.keys(`${SESSION_PREFIX}*`);
  let deleted = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      if ((JSON.parse(raw) as SessionData).userId === userId) {
        await redis.del(key);
        deleted++;
      }
    } catch {
      // ignore malformed entries
    }
  }
  return deleted;
}
