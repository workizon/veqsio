/**
 * Shared signed HTTP delivery used by plugin events and agent triggers: HMAC-SHA256 signature over
 * `<timestamp>.<body>`, never follows redirects, bounded retries with exponential back-off for network errors,
 * timeouts, 5xx, 429 and 408. The caller validates the URL (SSRF guard) and records the outcome.
 */
import { signPayload } from './signing';

export interface PostSignedOptions {
  url: string;
  /** Signs the delivery when set. Omitted for third-party incoming webhooks (Slack, Teams) that ignore signatures. */
  secret?: string;
  event: string;
  deliveryId: string;
  body: string;
  userAgent: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface PostSignedResult { ok: boolean; status: number | null; error: string | null; attempts: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postSigned(o: PostSignedOptions): Promise<PostSignedResult> {
  const doFetch = o.fetchImpl ?? fetch;
  let attempts = 0;
  let status: number | null = null;
  let error: string | null = null;
  let ok = false;
  while (attempts < Math.max(1, o.maxAttempts) && !ok) {
    attempts++;
    error = null;
    const ts = Math.floor(Date.now() / 1000);
    try {
      const res = await doFetch(o.url, {
        method: 'POST',
        redirect: 'manual', // never follow: a redirect could point at an internal address
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': o.userAgent,
          'X-Veqsio-Event': o.event,
          'X-Veqsio-Delivery': o.deliveryId,
          ...(o.secret ? { 'X-Veqsio-Timestamp': String(ts), 'X-Veqsio-Signature': signPayload(o.secret, ts, o.body) } : {}),
        },
        body: o.body,
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      status = res.status;
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) { ok = true; break; }
      error = `HTTP ${res.status}`;
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      if (!retryable) break;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : 'request failed';
    }
    if (attempts < o.maxAttempts) await sleep(o.retryBaseMs * 2 ** (attempts - 1));
  }
  return { ok, status, error: ok ? null : error, attempts };
}
