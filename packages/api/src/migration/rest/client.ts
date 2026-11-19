import { assertEgressUrl, outboundFetch } from '../../security/outbound'
/**
 * Minimal Jira REST client used by the REST importer.
 * Supports Jira Cloud (email + API token, Basic) and Server/Data Center (PAT, Bearer, or Basic user/password).
 * Always uses REST API v2 so descriptions/comments are plain wiki-markup strings on every flavour.
 */

export type JiraAuth =
  | { type: 'basic'; username: string; secret: string } // Cloud: email + API token; DC: user + password
  | { type: 'bearer'; token: string }                   // DC/Server personal access token

export interface JiraClientOptions {
  baseUrl: string
  auth: JiraAuth
  fetchImpl?: typeof fetch
  /** Max retries on 429/5xx. */
  retries?: number
  /** Sleep hook (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>
}

export class JiraHttpError extends Error {
  constructor(public status: number, public url: string, message: string) {
    super(message)
  }
}

/** Validate the user-supplied Jira URL. Private networks are allowed (on-prem Jira), but not link-local/metadata. */
export function normalizeBaseUrl(input: string): string {
  let u: URL
  try { u = new URL(input.trim()) } catch { throw new Error('Invalid Jira URL') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.MIGRATION_ALLOW_HTTP === 'true')) {
    throw new Error('Jira URL must use https')
  }
  if (u.username || u.password) throw new Error('Do not put credentials in the Jira URL')
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' && process.env.MIGRATION_ALLOW_PRIVATE_HOSTS !== 'true') throw new Error('Jira host is not allowed')
  if (/^169\.254\./.test(host) || host === 'metadata.google.internal' || host === '[fd00:ec2::254]') {
    throw new Error('Jira host is not allowed')
  }
  u.hash = ''; u.search = ''
  return u.toString().replace(/\/+$/, '')
}

export class JiraClient {
  readonly baseUrl: string
  private fetchImpl: typeof fetch
  private retries: number
  private sleep: (ms: number) => Promise<void>
  private authHeader: string

  constructor(opts: JiraClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl)
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.retries = opts.retries ?? 4
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.authHeader = opts.auth.type === 'bearer'
      ? `Bearer ${opts.auth.token}`
      : `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.secret}`).toString('base64')}`
  }

  private async request(url: string, accept = 'application/json', body?: unknown): Promise<Response> {
    // Only ever talk to the configured Jira host (attachment URLs from payloads are verified here).
    if (new URL(url).origin !== new URL(this.baseUrl).origin) {
      throw new Error('Refusing to fetch a URL outside the configured Jira host')
    }
    await assertEgressUrl(url) // importer targets are user supplied: no internal hosts on managed tenants
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: this.authHeader, Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        })
      } catch (e) {
        if (attempt++ >= this.retries) throw e
        await this.sleep(500 * 2 ** attempt)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        attempt++
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt)
        continue
      }
      // Attachment downloads on Cloud redirect to a media host; follow only same-origin or https redirects manually.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (loc && accept !== 'application/json') {
          const next = new URL(loc, url)
          if (next.protocol === 'https:') {
            // every further hop is checked as well (a redirect chain is the usual way past a check of the first address)
            return outboundFetch(next.toString(), { signal: AbortSignal.timeout(120_000) }, { fetchImpl: this.fetchImpl })
          }
        }
      }
      if (!res.ok) {
        throw new JiraHttpError(res.status, url, `Jira responded ${res.status} for ${new URL(url).pathname}`)
      }
      return res
    }
  }

  async get<T = any>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
    return (await this.request(u.toString())).json() as Promise<T>
  }

  /** A POST with a JSON body, for the few Jira queries that are not GETs (for example the permission check). */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    return (await this.request(this.baseUrl + path, 'application/json', body)).json() as Promise<T>
  }

  /** The bytes of a file; with `maxBytes` the download stops (and fails) once that much has arrived, so that a hostile host cannot fill the memory. */
  async download(url: string, maxBytes?: number): Promise<Buffer> {
    const res = await this.request(url, '*/*')
    if (maxBytes === undefined || !res.body) return Buffer.from(await res.arrayBuffer())
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body.cancel(); throw new Error('The file is larger than allowed') }
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) { await reader.cancel(); throw new Error('The file is larger than allowed') }
      chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }

  myself() { return this.get('/rest/api/2/myself') }
  projects() { return this.get<any[]>('/rest/api/2/project') }
  project(key: string) { return this.get(`/rest/api/2/project/${encodeURIComponent(key)}`) }

  /** Total issue count for a JQL, or null when the server no longer offers a cheap total (Jira Cloud). */
  async countIssues(jql: string): Promise<number | null> {
    try {
      const r = await this.get('/rest/api/2/search', { jql, maxResults: 0, fields: 'key' })
      return typeof r.total === 'number' ? r.total : null
    } catch (e) {
      if (e instanceof JiraHttpError && [400, 404, 410].includes(e.status)) return null
      throw e
    }
  }

  /** Iterate all issues for a JQL, handling both classic (startAt) and Cloud (nextPageToken) pagination. */
  async *searchIssues(jql: string, fields: string, expand?: string, pageSize = 50): AsyncGenerator<any> {
    let token: string | undefined
    let startAt = 0
    let useToken = false
    for (;;) {
      let page: any
      if (useToken) {
        page = await this.get('/rest/api/2/search/jql', { jql, fields, expand, maxResults: pageSize, nextPageToken: token })
      } else {
        try {
          page = await this.get('/rest/api/2/search', { jql, fields, expand, maxResults: pageSize, startAt })
        } catch (e) {
          if (e instanceof JiraHttpError && (e.status === 404 || e.status === 410 || e.status === 400) && startAt === 0) {
            useToken = true
            continue
          }
          throw e
        }
      }
      for (const issue of page.issues ?? []) yield issue
      if (useToken) {
        if (!page.nextPageToken || (page.issues ?? []).length === 0) return
        token = page.nextPageToken
      } else {
        startAt += (page.issues ?? []).length
        if ((page.issues ?? []).length === 0 || startAt >= (page.total ?? 0)) return
      }
    }
  }

  /** Agile API pagination ({ values, isLast, startAt }). */
  async getAgilePaged(path: string, params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const out: any[] = []
    let startAt = 0
    for (let page = 0; page < 1000; page++) {
      const r = await this.get(path, { ...params, startAt, maxResults: 50 })
      const items: any[] = r.values ?? []
      out.push(...items)
      startAt += items.length
      if (items.length === 0 || r.isLast === true || (r.isLast === undefined && startAt >= (r.total ?? 0))) return out
    }
    return out
  }

  /** Paged sub-resources such as /issue/KEY/comment or /issue/KEY/worklog. */
  async getAllPaged(path: string, listKey: string): Promise<any[]> {
    const out: any[] = []
    let startAt = 0
    for (;;) {
      const r = await this.get(path, { startAt, maxResults: 100 })
      const items: any[] = r[listKey] ?? []
      out.push(...items)
      startAt += items.length
      if (items.length === 0 || startAt >= (r.total ?? 0)) return out
    }
  }
}
