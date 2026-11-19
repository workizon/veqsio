import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Pure helpers for password-reset tokens (no DB / Redis access so they are trivially unit-testable). */

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything beyond 72 bytes

/** Generate a high-entropy URL-safe token (256 bits). Only its hash may be persisted. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest of the token; high-entropy tokens do not need a slow hash. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function resetTokenExpiry(now: Date = new Date(), ttlMs: number = RESET_TOKEN_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs);
}

export function isResetTokenFormatValid(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface ResetTokenRecord {
  expiresAt: Date;
  usedAt: Date | null;
}

export function isResetTokenUsable(record: ResetTokenRecord, now: Date = new Date()): boolean {
  if (record.usedAt) return false;
  return record.expiresAt.getTime() > now.getTime();
}

/** Returns an error message, or null when the password is acceptable. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes long`;
  }
  return null;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
