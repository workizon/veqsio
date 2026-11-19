import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * Bulk operations replay the normal single-issue endpoints in-process, so that permissions, workflow rules, history,
 * notifications and webhooks behave exactly as for one request. Those replays carry this per-process secret header:
 * they are not counted again by the rate limiter (the bulk request itself was). The secret never leaves the process.
 */
export const INTERNAL_HEADER = 'x-veqsio-internal';
const SECRET = randomBytes(24).toString('hex');

export const internalHeaders = (): Record<string, string> => ({ [INTERNAL_HEADER]: SECRET });

export function isInternalRequest(headerValue: string | undefined | null): boolean {
  if (!headerValue || headerValue.length !== SECRET.length) return false;
  return timingSafeEqual(Buffer.from(headerValue), Buffer.from(SECRET));
}
