import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { errorBody } from './errors';

export const SCIM_CONTENT_TYPE = 'application/scim+json';

export function generateScimToken(): string {
  return 'scim_' + randomBytes(32).toString('hex');
}

export function hashScimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function unauthorized() {
  return new Response(JSON.stringify(errorBody(401, 'Authentication required')), {
    status: 401,
    headers: { 'Content-Type': SCIM_CONTENT_TYPE, 'WWW-Authenticate': 'Bearer realm="scim"' },
  });
}

/**
 * Authenticates SCIM requests with a dedicated bearer token. User sessions and personal access tokens
 * are not accepted here.
 */
export const scimAuth: MiddlewareHandler = async (c, next) => {
  const m = /^Bearer\s+(\S{20,200})$/i.exec(c.req.header('Authorization') ?? '');
  if (!m) return unauthorized();
  const hash = hashScimToken(m[1]);
  const [row] = await db.select().from(schema.scimTokens)
    .where(and(eq(schema.scimTokens.tokenHash, hash), isNull(schema.scimTokens.revokedAt))).limit(1);
  const a = Buffer.from(hash);
  const b = Buffer.from(row?.tokenHash ?? '');
  if (!row || a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized();
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.scimTokens).set({ lastUsedAt: new Date() }).where(eq(schema.scimTokens.id, row.id));
  }
  await next();
};
