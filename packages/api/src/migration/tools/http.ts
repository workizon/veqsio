/**
 * Small HTTP helper shared by the Linear, Asana and ClickUp clients.
 *  - fetch and sleep are injectable (tests never touch the network)
 *  - only the configured origin is ever contacted (pagination URLs from payloads are verified)
 *  - 429 and 5xx are retried with Retry-After / rate-limit-reset aware backoff
 *  - 401/403 become ToolAuthError so the UI can say "token rejected" without echoing upstream bodies
 *
 * The base URLs are fixed per provider (never user supplied), so there is no SSRF surface to guard; the origin check
 * below additionally stops a malicious pagination link from redirecting the token to another host.
 */

export class ToolHttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export class ToolAuthError extends ToolHttpError {
  constructor(status: number, provider: string) {
    super(status, `${provider} rejected the credentials (HTTP ${status}). Check the token and its permissions.`)
  }
}
export class ToolRateLimitError extends ToolHttpError {
  constructor(provider: string) { super(429, `${provider} rate limit exceeded; retries exhausted. Try again in a few minutes.`) }
}

export interface ToolHttpOptions {
  provider: string
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
  retries?: number
  sleep?: (ms: number) => Promise<void>
  /** Upper bound for one wait, so a bad Retry-After cannot stall a job for hours. */
  maxWaitMs?: number
  now?: () => number
}

/** Seconds from a Retry-After header (delta seconds or HTTP date); null if absent/invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : Math.max(0, (t - now) / 1000)
}

export class ToolHttp {
  private fetchImpl: typeof fetch
  private retries: number
  readonly sleep: (ms: number) => Promise<void>
  private maxWait: number
  private now: () => number
  readonly origin: string

  constructor(private opts: ToolHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.retries = opts.retries ?? 5
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxWait = opts.maxWaitMs ?? 60_000
    this.now = opts.now ?? Date.now
    this.origin = new URL(opts.baseUrl).origin
  }

  /** Wait time for a throttled/failed response: Retry-After, then reset headers, then exponential backoff. */
  waitMs(res: Response | null, attempt: number): number {
    let secs: number | null = null
    if (res) {
      secs = parseRetryAfter(res.headers.get('retry-after'), this.now())
      if (secs === null) {
        // ClickUp: X-RateLimit-Reset = epoch seconds. Linear: X-RateLimit-Requests-Reset = epoch milliseconds.
        const reset = Number(res.headers.get('x-ratelimit-reset'))
        const resetMs = Number(res.headers.get('x-ratelimit-requests-reset'))
        if (Number.isFinite(reset) && reset > 1e9) secs = Math.max(0, reset - this.now() / 1000)
        else if (Number.isFinite(resetMs) && resetMs > 1e12) secs = Math.max(0, (resetMs - this.now()) / 1000)
      }
    }
    const ms = secs !== null ? secs * 1000 : 500 * 2 ** attempt
    return Math.min(this.maxWait, Math.max(0, ms))
  }

  async request(
    method: 'GET' | 'POST',
    urlOrPath: string,
    init: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; okStatuses?: number[] } = {},
  ): Promise<{ status: number; headers: Headers; json: any }> {
    // '' = the base URL itself (GraphQL); relative paths (no leading slash) are appended to it; absolute URLs are origin-checked.
    const url = urlOrPath ? new URL(urlOrPath, this.opts.baseUrl.replace(/\/?$/, '/')) : new URL(this.opts.baseUrl)
    if (url.origin !== this.origin) throw new Error(`Refusing to contact a host outside ${this.opts.provider}`)
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...this.opts.headers },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        })
      } catch {
        if (attempt++ >= this.retries) throw new ToolHttpError(0, `Could not reach ${this.opts.provider}`)
        await this.sleep(this.waitMs(null, attempt))
        continue
      }
      if (res.status === 401 || res.status === 403) throw new ToolAuthError(res.status, this.opts.provider)
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.retries) {
          if (res.status === 429) throw new ToolRateLimitError(this.opts.provider)
          throw new ToolHttpError(res.status, `${this.opts.provider} responded ${res.status}`)
        }
        attempt++
        await this.sleep(this.waitMs(res, attempt))
        continue
      }
      const ok = res.ok || (init.okStatuses ?? []).includes(res.status)
      if (!ok) throw new ToolHttpError(res.status, `${this.opts.provider} responded ${res.status} for ${url.pathname}`)
      let json: any = null
      try { json = await res.json() } catch { json = null }
      return { status: res.status, headers: res.headers, json }
    }
  }
}
