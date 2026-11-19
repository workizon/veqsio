import { describe, test, expect } from 'bun:test';
import {
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
  isResetTokenFormatValid,
  isResetTokenUsable,
  validateNewPassword,
  hashesEqual,
  RESET_TOKEN_TTL_MS,
} from './reset-token';
import { passwordResetTemplate } from '../email-templates/password-reset.html';

process.env.REDIS_URL = 'memory:';

describe('reset token generation', () => {
  test('tokens are unique, URL-safe and well-formed', () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isResetTokenFormatValid(a)).toBe(true);
  });

  test('hash is deterministic, hex SHA-256 and differs from the token', () => {
    const t = generateResetToken();
    const h = hashResetToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashResetToken(t));
    expect(h).not.toBe(t);
    expect(hashResetToken(generateResetToken())).not.toBe(h);
    expect(hashesEqual(h, hashResetToken(t))).toBe(true);
    expect(hashesEqual(h, 'abc')).toBe(false);
  });

  test('rejects malformed tokens', () => {
    expect(isResetTokenFormatValid('')).toBe(false);
    expect(isResetTokenFormatValid('short')).toBe(false);
    expect(isResetTokenFormatValid(undefined)).toBe(false);
    expect(isResetTokenFormatValid({})).toBe(false);
    expect(isResetTokenFormatValid('a'.repeat(42) + '!')).toBe(false);
  });
});

describe('reset token expiry and single use', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('expiry is TTL after issue time', () => {
    expect(resetTokenExpiry(now).getTime() - now.getTime()).toBe(RESET_TOKEN_TTL_MS);
  });

  test('fresh unused token is usable', () => {
    expect(isResetTokenUsable({ expiresAt: resetTokenExpiry(now), usedAt: null }, now)).toBe(true);
  });

  test('expired token is not usable (including exactly at expiry)', () => {
    const expiresAt = resetTokenExpiry(now);
    expect(isResetTokenUsable({ expiresAt, usedAt: null }, expiresAt)).toBe(false);
    expect(isResetTokenUsable({ expiresAt, usedAt: null }, new Date(expiresAt.getTime() + 1))).toBe(false);
  });

  test('used token is not usable', () => {
    expect(isResetTokenUsable({ expiresAt: resetTokenExpiry(now), usedAt: now }, now)).toBe(false);
  });
});

describe('new password validation', () => {
  test('accepts a reasonable password', () => {
    expect(validateNewPassword('correct horse battery')).toBeNull();
  });
  test('rejects short, missing and overlong passwords', () => {
    expect(validateNewPassword('short')).not.toBeNull();
    expect(validateNewPassword(undefined)).not.toBeNull();
    expect(validateNewPassword(12345678)).not.toBeNull();
    expect(validateNewPassword('x'.repeat(73))).not.toBeNull();
    expect(validateNewPassword('x'.repeat(72))).toBeNull();
  });
});

describe('password reset email template', () => {
  test('escapes user-controlled values', () => {
    const { html } = passwordResetTemplate({
      displayName: '<script>alert(1)</script>',
      resetUrl: 'https://x.test/reset?token=a"><img src=x>',
      expiresInMinutes: 60,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('reset rate limiting', () => {
  test('blocks after the limit is exceeded', async () => {
    const { consumeRateLimit } = await import('./password-reset');
    const id = `test-${Math.random()}`;
    expect(await consumeRateLimit('t', id, 2)).toBe(true);
    expect(await consumeRateLimit('t', id, 2)).toBe(true);
    expect(await consumeRateLimit('t', id, 2)).toBe(false);
    expect(await consumeRateLimit('t', `${id}-other`, 2)).toBe(true);
  });
});
