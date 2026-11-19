/**
 * Abuse and cost limits for AI calls: per-user daily quota (rolling 24 h, counted in ai_usage so admins can see it),
 * a per-user burst limit, and a global concurrency cap. Concurrency slots are a sorted set of timestamps
 * (works with Redis and the in-memory store) so a crashed request cannot hold a slot for longer than SLOT_TTL_MS.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { redis } from '../services/cache';
import { consumeLimit } from '../servicedesk/limits';

export const DAY_MS = 86_400_000;
const SLOT_TTL_MS = 90_000;
const SLOT_KEY = 'veqsio:ai:slots';

export const maxConcurrent = () => {
  const n = Number(process.env.AI_MAX_CONCURRENT);
  return Number.isInteger(n) && n > 0 ? n : 4;
};
export const burstPerMinute = () => {
  const n = Number(process.env.AI_BURST_PER_MINUTE);
  return Number.isInteger(n) && n > 0 ? n : 20;
};

export class AiLimitError extends Error {
  constructor(message: string, readonly status: 429 | 503, readonly retryAfter: number) {
    super(message);
    this.name = 'AiLimitError';
  }
}

/** Reserves one request against the daily quota; the row doubles as the usage record. Returns its id. */
export async function reserveDailyUsage(userId: number, feature: string, limit: number, now = Date.now()): Promise<number> {
  const burst = await consumeLimit(`ai-burst:${userId}`, burstPerMinute(), 60_000);
  if (!burst.allowed) throw new AiLimitError('Too many AI requests. Please slow down.', 429, burst.retryAfter);
  const [row] = await db.insert(schema.aiUsage).values({ userId, feature, createdAt: new Date(now) }).returning({ id: schema.aiUsage.id });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), gte(schema.aiUsage.createdAt, new Date(now - DAY_MS))));
  if (n > limit) {
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.id, row.id));
    throw new AiLimitError('Daily AI request limit reached', 429, 3600);
  }
  return row.id;
}

/** Gives the quota back (used when the provider failed, so an outage does not burn users' allowance). */
export async function refundUsage(id: number): Promise<void> {
  await db.delete(schema.aiUsage).where(eq(schema.aiUsage.id, id));
}

export async function recordTokens(id: number, tokensIn?: number, tokensOut?: number): Promise<void> {
  if (tokensIn === undefined && tokensOut === undefined) return;
  await db.update(schema.aiUsage).set({ tokensIn: tokensIn ?? null, tokensOut: tokensOut ?? null }).where(eq(schema.aiUsage.id, id));
}

/** Global concurrency cap. Returns a release function. Fails closed with 503 when saturated. */
export async function acquireSlot(max = maxConcurrent()): Promise<() => Promise<void>> {
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2)}`;
  const res = await redis.pipeline()
    .zremrangebyscore(SLOT_KEY, 0, now - SLOT_TTL_MS)
    .zadd(SLOT_KEY, now, member)
    .zcard(SLOT_KEY)
    .pexpire(SLOT_KEY, SLOT_TTL_MS)
    .exec();
  const count = Number(res?.[2]?.[1] ?? 0);
  const release = async () => { try { await redis.zrem(SLOT_KEY, member); } catch { /* slot expires on its own */ } };
  if (count > max) {
    await release();
    throw new AiLimitError('AI is busy. Please try again shortly.', 503, 5);
  }
  return release;
}

export async function usageSummary(days = 7): Promise<{ total: number; byFeature: Record<string, number>; since: string }> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db.select({ feature: schema.aiUsage.feature, n: sql<number>`count(*)::int` }).from(schema.aiUsage)
    .where(gte(schema.aiUsage.createdAt, since)).groupBy(schema.aiUsage.feature);
  const byFeature: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byFeature[r.feature] = r.n; total += r.n; }
  return { total, byFeature, since: since.toISOString() };
}
