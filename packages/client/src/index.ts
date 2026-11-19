/**
 * Typed client for the Veqsio REST API.
 *
 * It only uses `fetch`, so it runs on Bun, Node 18+ and in browsers, and tests can inject a `fetch`
 * (a fake server or `app.request`). Every call goes through the public REST API, so all permission
 * checks and personal-access-token scopes of the server apply. Nothing here touches the database.
 *
 * Errors are mapped to {@link VeqsioError} with a stable `kind` (auth, forbidden, not_found, license,
 * validation, rate_limited, server, network) so callers do not parse status codes themselves.
 */

export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'license' | 'validation' | 'rate_limited' | 'server' | 'network'

export class VeqsioError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    public readonly status: number,
    message: string,
    public readonly messages: string[] = [message],
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'VeqsioError'
  }
}

export function kindForStatus(status: number): ErrorKind {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 402) return 'license'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'validation'
}

export interface ClientOptions {
  /** Base URL of the instance API, for example `https://jira.example.com` (no trailing path). */
  baseUrl: string
  /** Personal access token (`veqsio_...`). Optional: only the public API works without one. */
  token?: string
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Per request timeout in milliseconds (default 20000). */
  timeoutMs?: number
  userAgent?: string
}

export interface Page<T> { startAt: number; maxResults: number; total: number; items: T[] }

/* ------------------------------- response types ------------------------------- */

export interface Myself { id: number; key: string; name: string; emailAddress?: string; active: boolean; timeZone?: string }
export interface ProjectSummary { id: number; key: string; name: string; description?: string | null; projectCategory?: string | null }
export interface ProjectDetail extends ProjectSummary {
  lead: { id: number; displayName?: string } | null
  isPublic?: boolean
  issueTypes: Array<{ id: string; name: string; description?: string | null; subtask: boolean }>
}
export interface IssueRef { id: number; key: string; summary: string }
export interface IssueLink { id: number; type: { id: number; name: string; inward?: string; outward?: string }; inwardIssue?: IssueRef; outwardIssue?: IssueRef }
export interface Issue {
  id: number
  key: string
  fields: {
    summary: string
    description: string | null
    status: { id: number; name: string; category?: string }
    issuetype: { id: number; name: string; subtask?: boolean }
    priority: { id: number; name: string } | null
    resolution: { id: number; name: string } | null
    assignee: { id: number; displayName: string } | null
    reporter: { id: number; displayName: string }
    project: { id: number; key: string; name: string }
    created: string
    updated: string
    resolved: string | null
    duedate: string | null
    storyPoints?: number | null
    labels: string[]
    components?: Array<{ id: number; name: string }>
    fixVersions?: Array<{ id: number; name: string }>
    parent?: { id: number; key?: string; summary?: string } | null
    sprint?: { id: number; name: string; state: string } | null
    subtasks?: Array<{ id: number; key: string; summary: string; status?: { id: number } }>
    issuelinks?: IssueLink[]
    [custom: string]: unknown
  }
}
export interface SearchResult { startAt: number; maxResults: number; total: number; issues: Issue[] }
export interface Comment { id: string; author: { id: number } | null; body: string; internal?: boolean; created: string; updated: string }
export interface Transition {
  id: number | string
  name: string
  to: { id: number; name: string; statusCategory?: { key?: string; name?: string } }
  requiresResolution?: boolean
  requiresComment?: boolean
  requiredFields?: string[]
}
export interface Development {
  branches: Array<Record<string, unknown>>
  commits: Array<Record<string, unknown>>
  pullRequests: Array<Record<string, unknown>>
  suggestedBranch?: string
}
export interface CreateMetaIssueType { id: string; name: string; subtask: boolean; fields?: Record<string, { required: boolean; name: string; allowedValues?: Array<{ id: string; name: string }>; schema?: { type: string } }> }
export interface CreateMetaProject { id: string; key: string; name: string; issuetypes: CreateMetaIssueType[] }
export interface LinkType { id: string; name: string; inward: string; outward: string }
export interface Board { id: number; name: string; type: string; projectId: number }
export interface Sprint { id: number; name: string; goal?: string | null; state: string; startDate?: string; endDate?: string; originBoardId?: number }
export interface Version { id: number; name: string; description?: string | null; releaseDate?: string | null; released: boolean; archived?: boolean }
export interface UserRef { id: number; key: string; name: string; emailAddress?: string; active: boolean }

export interface PublicProject { key: string; name: string; description?: string | null; category?: string | null; issueCount: number; updated?: string }
export interface PublicIssue {
  key: string; summary: string; description: string | null
  project: { key: string; name: string }
  type: string; status: string; statusCategory?: string; priority: string | null
  assignee: string | null; reporter: string | null
  labels: string[]; fixVersions: string[]
  created: string; updated: string; resolved: string | null
  comments: Array<{ id: number; author: string | null; body: string; created: string }>
}

export interface CreateIssueInput {
  projectId: number
  issueTypeId: number
  summary: string
  description?: string
  priorityId?: number
  assigneeId?: number
  parentId?: number
  labels?: string[]
  components?: number[]
  fixVersions?: number[]
  dueDate?: string
  storyPoints?: number
}

/* ---------------------------------- client ---------------------------------- */

type Query = Record<string, string | number | boolean | undefined | null>

export class VeqsioClient {
  private readonly base: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly userAgent: string

  constructor(opts: ClientOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required')
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token || undefined
    this.fetchImpl = opts.fetch ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch)
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.userAgent = opts.userAgent ?? '@veqsio/client'
  }

  get hasToken(): boolean { return !!this.token }

  /** Low level request. `anonymous: true` never sends the token (public API). */
  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; anonymous?: boolean; text?: boolean } = {}): Promise<T> {
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { Accept: opts.text ? 'text/markdown, text/plain, */*' : 'application/json', 'User-Agent': this.userAgent }
    if (this.token && !opts.anonymous) headers.Authorization = `Bearer ${this.token}`
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new VeqsioError('network', 0, `Cannot reach ${this.base}: ${msg}`)
    }
    const raw = await res.text()
    if (!res.ok) throw this.toError(res.status, raw)
    if (opts.text) return raw as T
    if (!raw) return undefined as T
    try { return JSON.parse(raw) as T } catch { throw new VeqsioError('server', res.status, 'The server returned a response that is not JSON') }
  }

  private toError(status: number, raw: string): VeqsioError {
    let body: any
    try { body = JSON.parse(raw) } catch { body = undefined }
    const msgs: string[] = []
    if (Array.isArray(body?.errorMessages)) msgs.push(...body.errorMessages.filter((m: unknown) => typeof m === 'string'))
    if (body?.errors && typeof body.errors === 'object') for (const [k, v] of Object.entries(body.errors)) msgs.push(`${k}: ${String(v)}`)
    if (typeof body?.message === 'string') msgs.push(body.message)
    const kind = kindForStatus(status)
    const fallback = kind === 'auth' ? 'Not authenticated (token missing, wrong, expired or revoked)'
      : kind === 'forbidden' ? 'Forbidden'
      : kind === 'not_found' ? 'Not found (or not visible to this token)'
      : kind === 'license' ? 'This needs a Veqsio Enterprise licence'
      : kind === 'rate_limited' ? 'Rate limited, retry later'
      : `HTTP ${status}`
    const list = msgs.length ? msgs : [fallback]
    return new VeqsioError(kind, status, list.join('; '), list, body)
  }

  /* ---- identity and metadata ---- */
  myself() { return this.request<Myself>('GET', '/rest/api/2/myself') }
  async searchUsers(query: string): Promise<UserRef[]> { return this.request<UserRef[]>('GET', '/rest/api/2/user/search', { query: { query } }) }
  async linkTypes(): Promise<LinkType[]> { return (await this.request<{ issueLinkTypes: LinkType[] }>('GET', '/rest/api/2/issueLinkType')).issueLinkTypes }

  /* ---- projects ---- */
  listProjects() { return this.request<ProjectSummary[]>('GET', '/rest/api/2/project') }
  getProject(key: string) { return this.request<ProjectDetail>('GET', `/rest/api/2/project/${encodeURIComponent(key)}`) }
  async createMeta(projectKey: string): Promise<CreateMetaProject | undefined> {
    const r = await this.request<{ projects: CreateMetaProject[] }>('GET', '/rest/api/2/issue/createmeta', { query: { projectKeys: projectKey, expand: 'projects.issuetypes.fields' } })
    return r.projects[0]
  }
  versions(projectKey: string) { return this.request<Version[]>('GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`) }
  releaseNotes(projectKey: string, versionId: number) {
    return this.request<string>('GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}/versions/${versionId}/release-notes`, { text: true })
  }

  /* ---- issues ---- */
  searchIssues(jql: string, startAt = 0, maxResults = 25) { return this.request<SearchResult>('GET', '/rest/api/2/search', { query: { jql, startAt, maxResults } }) }
  getIssue(key: string) { return this.request<Issue>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}`) }
  async getComments(key: string): Promise<Comment[]> { return (await this.request<{ comments: Comment[] }>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`)).comments }
  getDevelopment(key: string) { return this.request<Development>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/development`) }
  createIssue(input: CreateIssueInput) {
    const fields: Record<string, unknown> = {
      project: { id: input.projectId },
      issuetype: { id: input.issueTypeId },
      summary: input.summary,
    }
    if (input.description !== undefined) fields.description = input.description
    if (input.priorityId !== undefined) fields.priority = { id: input.priorityId }
    if (input.assigneeId !== undefined) fields.assignee = { id: input.assigneeId }
    if (input.parentId !== undefined) fields.parent = { id: input.parentId }
    if (input.labels) fields.labels = input.labels
    if (input.components) fields.components = input.components.map((id) => ({ id }))
    if (input.fixVersions) fields.fixVersions = input.fixVersions.map((id) => ({ id }))
    if (input.dueDate !== undefined) fields.duedate = input.dueDate
    if (input.storyPoints !== undefined) fields.storyPoints = input.storyPoints
    return this.request<{ id: number; key: string }>('POST', '/rest/api/2/issue', { body: { fields } })
  }
  /** `fields` uses the Jira-style shape of PUT /issue (for example `{ summary }`, `{ assignee: { id } }`, `{ assignee: null }`). */
  updateIssue(key: string, fields: Record<string, unknown>) { return this.request<Issue>('PUT', `/rest/api/2/issue/${encodeURIComponent(key)}`, { body: { fields } }) }
  addComment(key: string, body: string) { return this.request<{ id: number | string }>('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: { body } }) }
  async transitions(key: string): Promise<Transition[]> { return (await this.request<{ transitions: Transition[] }>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`)).transitions }
  transition(key: string, transitionId: number | string, extra: { comment?: string; fields?: Record<string, unknown> } = {}) {
    return this.request<void>('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      body: { transition: { id: transitionId }, ...(extra.fields ? { fields: extra.fields } : {}), ...(extra.comment ? { update: { comment: [{ add: { body: extra.comment } }] } } : {}) },
    })
  }
  /** `inwardId` is the issue that gets the inward phrase ("is blocked by"), `outwardId` the one with the outward phrase ("blocks"). */
  linkIssues(inwardId: number, outwardId: number, typeId: number) {
    return this.request<void>('POST', '/rest/api/2/issueLink', { body: { type: { id: typeId }, inwardIssue: { id: inwardId }, outwardIssue: { id: outwardId } } })
  }

  /* ---- agile ---- */
  async boards(projectId?: number): Promise<Board[]> { return (await this.request<{ values: Board[] }>('GET', '/rest/agile/1.0/board', { query: { projectId } })).values }
  async sprints(boardId: number, state?: string): Promise<Sprint[]> { return (await this.request<{ values: Sprint[] }>('GET', `/rest/agile/1.0/board/${boardId}/sprint`, { query: { state } })).values }
  sprintIssues(sprintId: number, startAt = 0, maxResults = 50) { return this.request<{ startAt: number; maxResults: number; total: number; issues: Array<Record<string, any>> }>('GET', `/rest/agile/1.0/sprint/${sprintId}/issue`, { query: { startAt, maxResults } }) }

  /* ---- anonymous public API (never sends the token) ---- */
  publicConfig() { return this.request<{ enabled: boolean; siteName: string; baseUrl: string }>('GET', '/rest/public/config', { anonymous: true }) }
  async publicProjects(): Promise<PublicProject[]> { return (await this.request<{ projects: PublicProject[] }>('GET', '/rest/public/projects', { anonymous: true })).projects }
  publicProjectIssues(key: string, q: { startAt?: number; maxResults?: number; q?: string; type?: string; status?: string } = {}) {
    return this.request<{ startAt: number; maxResults: number; total: number; issues: Array<{ key: string; summary: string; type: string; status: string; priority: string | null; updated: string }> }>(
      'GET', `/rest/public/projects/${encodeURIComponent(key)}/issues`, { anonymous: true, query: q })
  }
  publicIssue(key: string) { return this.request<PublicIssue>('GET', `/rest/public/issues/${encodeURIComponent(key)}`, { anonymous: true }) }
}
