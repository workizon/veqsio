import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two secrets of any length (both are hashed to a fixed size first). */
export function tokenMatches(given: string | undefined | null, expected: string | undefined | null): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
