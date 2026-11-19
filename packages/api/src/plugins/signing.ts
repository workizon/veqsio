/**
 * Delivery signatures: HMAC-SHA256 over `<timestamp>.<raw body>` with the per-plugin signing secret.
 * Header format: `X-Veqsio-Signature: v1=<hex>` and `X-Veqsio-Timestamp: <unix seconds>`.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNATURE_VERSION = 'v1';
export const REPLAY_WINDOW_SECONDS = 300;

export function signPayload(secret: string, timestamp: number | string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

/** Reference verifier (also what the docs snippets implement). `now` is unix seconds. */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  now: number = Math.floor(Date.now() / 1000),
  windowSeconds = REPLAY_WINDOW_SECONDS
): VerifyResult {
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith(`${SIGNATURE_VERSION}=`)) return { ok: false, reason: 'malformed' };
  if (Math.abs(now - Number(timestamp)) > windowSeconds) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
