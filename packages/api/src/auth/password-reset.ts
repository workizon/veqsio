import { db } from '../db';
import * as schema from '@veqsio/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { redis } from '../services/cache';
import { sendEmailDirect } from '../services/email';
import { hashPassword } from './password';
import { checkPasswordPolicy } from '../settings/instance';
import { deleteAllUserSessions } from './session';
import {
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  isResetTokenFormatValid,
  resetTokenExpiry,
  validateNewPassword,
} from './reset-token';

const REQUEST_LIMIT_PER_IP = 10; // per hour
const REQUEST_LIMIT_PER_EMAIL = 3; // per hour
const CONFIRM_LIMIT_PER_IP = 20; // per hour
const WINDOW_MS = 60 * 60 * 1000;

/** Sliding-window counter. Returns true when the call is allowed. Fails open if Redis is unavailable. */
export async function consumeRateLimit(bucket: string, id: string, max: number, windowMs = WINDOW_MS): Promise<boolean> {
  try {
    const key = `veqsio:ratelimit:pwreset:${bucket}:${id}`;
    const now = Date.now();
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, now - windowMs);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs);
    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;
    return count <= max;
  } catch (err) {
    console.error('[password-reset] rate limit check failed', err);
    return true;
  }
}

/** The legacy Microsoft SSO page has an "Enforce SSO" switch: with it on, password sign-in is refused like it is for the other providers (system administrators keep it as a way in when the identity provider breaks). */
export async function legacySsoPasswordLoginBlockedFor(userId: number): Promise<boolean> {
  if (!(await isSsoEnforced())) return false
  const { hasGlobalPermission } = await import('../rbac/service')
  return !(await hasGlobalPermission(userId, 'SYSTEM_ADMIN'))
}

export async function isSsoEnforced(): Promise<boolean> {
  const rows = await db.select().from(schema.ssoSettings).where(eq(schema.ssoSettings.active, true)).limit(1);
  return rows.length > 0 && rows[0].enforceSso === true;
}

function getWebUrl(): string {
  return (process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

/**
 * Issue a reset token and email it, if (and only if) the email belongs to an active local account
 * and SSO is not enforced. Never reveals whether the account exists; callers must respond identically.
 */
export async function requestPasswordReset(email: string, ip: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 255) return;

  if (!(await consumeRateLimit('req-ip', ip, REQUEST_LIMIT_PER_IP))) return;
  if (!(await consumeRateLimit('req-email', normalized, REQUEST_LIMIT_PER_EMAIL))) return;

  if (await isSsoEnforced()) return;

  const rows = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${normalized}`).limit(1);
  const user = rows[0];
  // Only active accounts with a local password may reset (SSO-provisioned users have no password hash).
  if (!user || user.active === false || !user.passwordHash) return;

  const token = generateResetToken();
  const now = new Date();

  // Invalidate any outstanding tokens, then store the new one (hash only).
  await db
    .update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(schema.passwordResetTokens.userId, user.id), isNull(schema.passwordResetTokens.usedAt)));
  await db.insert(schema.passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashResetToken(token),
    expiresAt: resetTokenExpiry(now),
  });

  const resetUrl = `${getWebUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  // Sent directly (not via email_queue) so the raw token is never persisted.
  await sendEmailDirect(user.email, 'password-reset', {
    displayName: user.displayName,
    resetUrl,
    expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
  });
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; status: 400 | 429; message: string };

const INVALID_TOKEN: ConfirmResult = { ok: false, status: 400, message: 'This reset link is invalid or has expired' };

export async function confirmPasswordReset(token: unknown, newPassword: unknown, ip: string): Promise<ConfirmResult> {
  if (!(await consumeRateLimit('confirm-ip', ip, CONFIRM_LIMIT_PER_IP))) {
    return { ok: false, status: 429, message: 'Too many attempts. Please try again later.' };
  }
  if (!isResetTokenFormatValid(token)) return INVALID_TOKEN;
  const pwError = validateNewPassword(newPassword) ?? (typeof newPassword === 'string' ? await checkPasswordPolicy(newPassword) : null);
  if (pwError) return { ok: false, status: 400, message: pwError };
  if (await isSsoEnforced()) {
    return { ok: false, status: 400, message: 'Password reset is disabled because single sign-on is enforced' };
  }

  const tokenHash = hashResetToken(token);
  const passwordHash = await hashPassword(newPassword as string);
  const now = new Date();

  // Atomically consume the token (single use, unexpired) so concurrent requests cannot both succeed.
  const consumed = await db
    .update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.passwordResetTokens.tokenHash, tokenHash),
        isNull(schema.passwordResetTokens.usedAt),
        gt(schema.passwordResetTokens.expiresAt, now),
      ),
    )
    .returning({ userId: schema.passwordResetTokens.userId });
  if (consumed.length === 0) return INVALID_TOKEN;
  const userId = consumed[0].userId;

  const updated = await db
    .update(schema.users)
    .set({ passwordHash, updatedAt: now })
    .where(and(eq(schema.users.id, userId), sql`${schema.users.active} is not false`))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return INVALID_TOKEN;

  // Burn any other outstanding tokens and sign the user out everywhere.
  await db
    .update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(schema.passwordResetTokens.userId, userId), isNull(schema.passwordResetTokens.usedAt)));
  await deleteAllUserSessions(userId);

  return { ok: true };
}
