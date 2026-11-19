/** Authentication of inbound webhook calls: HMAC-SHA256 over the raw body, or a shared secret header. All comparisons are constant time. */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const hmacHex = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time string equality (compares SHA-256 digests, so length differences leak nothing). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Accepts `sha256=<hex>` (GitHub style) and bare hex (Sentry style); the hex is case-insensitive.
 * The signature covers the exact raw bytes of the request body.
 */
export function verifyHmac(secret: string, rawBody: string, header: string | undefined | null): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return safeEqual(hmacHex(secret, rawBody), given);
}

/** Shared secret from `X-Veqsio-Secret` or `Authorization: Bearer <secret>`. */
export function providedSecret(get: (name: string) => string | undefined): string {
  const direct = get('x-veqsio-secret');
  if (direct) return direct;
  const auth = get('authorization') ?? '';
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
}

/** Idempotency key sent by the caller: dedicated headers first, then the provider delivery ids. */
export function headerIdempotencyKey(get: (name: string) => string | undefined, type: string): string | null {
  const names = ['idempotency-key', 'x-idempotency-key', 'x-github-delivery', ...(type === 'sentry' ? ['request-id'] : [])];
  for (const n of names) {
    const v = get(n)?.trim();
    if (v) return v.slice(0, 200);
  }
  return null;
}
