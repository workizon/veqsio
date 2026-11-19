import { ToolHttp, ToolHttpError, type ToolHttpOptions } from './http'
import type {
  ExtractContext, ExtractOptions, SourceAdapter, SourceInfo, StatusCategory, ToolComment, ToolContainer, ToolIssue, ToolItem, ToolProject, ToolUser,
} from './model'
import { deriveKey } from './engine'

export const LINEAR_INFO: SourceInfo = {
  id: 'linear',
  name: 'Linear',
  mode: 'live',
  tokenHelp: 'Linear > Settings > Account > Security & access > Personal API keys. A read-only key is enough.',
  maps: [
    'Teams become projects (team key kept as the project key when free)',
    'Workflow states become statuses and board columns',
    'Cycles become sprints on a scrum board',
    'Linear projects become components',
    'Labels, priority (Urgent=Highest .. Low), estimate (as story points), due date, assignee and creator (matched by e-mail)',
    'Comments, parent and sub-issues, relations (blocks, duplicate, related) as issue links',
  ],
  unsupported: [
    'Attachments and linked URLs', 'Reactions', 'Subscribers', 'Customer requests', 'Initiatives and project milestones',
    'SLAs', 'Issue templates', 'Documents', 'Triage responsibility', 'Issue history',
  ],
}

const PRIORITY: Record<number, string | null> = { 0: null, 1: 'Highest', 2: 'High', 3: 'Medium', 4: 'Low' }

export function linearCategory(type: string | undefined | null): StatusCategory {
  switch (type) {
    case 'started': return 'in_progress'
    case 'completed': case 'canceled': return 'done'
    default: return 'todo' // triage, backlog, unstarted
  }
}

const date = (v: unknown): Date | null => {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export function linearUser(u: any): ToolUser | null {
  if (!u) return null
  return { externalId: u.id, email: u.email ?? null, name: u.displayName || u.name || null }
}

export function linearLinkKind(type: string | undefined): 'Blocks' | 'Duplicate' | 'Relates' {
  if (type === 'blocks') return 'Blocks'
  if (type === 'duplicate') return 'Duplicate'
  return 'Relates' // related, similar
}

function mapComment(c: any): ToolComment {
  return { id: String(c.id), author: linearUser(c.user), body: String(c.body ?? ''), createdAt: date(c.createdAt), updatedAt: date(c.updatedAt) }
}

export function mapLinearIssue(raw: any, teamId: string, unsupported: ExtractContext['unsupported']): ToolIssue {
  const isCanceled = raw.state?.type === 'canceled'
  const labelNames: string[] = (raw.labels?.nodes ?? []).map((l: any) => String(l.name))
  if (raw.estimate !== null && raw.estimate !== undefined && typeof raw.estimate !== 'number') unsupported.add('non-numeric estimates')
  if (raw.attachments?.nodes?.length) unsupported.add('attachments / linked URLs', raw.attachments.nodes.length)
  const bug = labelNames.some((l) => l.toLowerCase() === 'bug')
  return {
    id: String(raw.id),
    identifier: raw.identifier ?? null,
    projectId: teamId,
    title: String(raw.title ?? ''),
    description: raw.description ?? null,
    type: raw.parent ? 'Sub-task' : bug ? 'Bug' : 'Task',
    isSubtask: !!raw.parent,
    status: { name: String(raw.state?.name ?? 'Backlog'), category: linearCategory(raw.state?.type) },
    priority: PRIORITY[Number(raw.priority ?? 0)] ?? null,
    resolution: isCanceled ? "Won't Do" : raw.state?.type === 'completed' ? 'Done' : null,
    assignee: linearUser(raw.assignee),
    creator: linearUser(raw.creator),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
    resolvedAt: date(raw.completedAt) ?? date(raw.canceledAt),
    dueDate: date(raw.dueDate),
    startDate: date(raw.startedAt),
    labels: labelNames,
    components: raw.project?.name ? [String(raw.project.name)] : [],
    parentId: raw.parent?.id ? String(raw.parent.id) : null,
    storyPoints: typeof raw.estimate === 'number' ? raw.estimate : null,
    sprintId: raw.cycle?.id ? String(raw.cycle.id) : null,
    comments: (raw.comments?.nodes ?? []).map(mapComment),
    links: (raw.relations?.nodes ?? []).filter((r: any) => r.relatedIssue?.id).map((r: any) => ({ targetId: String(r.relatedIssue.id), kind: linearLinkKind(r.type) })),
    url: raw.url ?? null,
  }
}

function cycleState(c: any, now = Date.now()): 'future' | 'active' | 'closed' {
  if (c.completedAt) return 'closed'
  const s = date(c.startsAt)?.getTime(), e = date(c.endsAt)?.getTime()
  if (s !== undefined && e !== undefined && s <= now && now < e) return 'active'
  if (e !== undefined && e <= now) return 'closed'
  return 'future'
}

const ISSUE_FIELDS = `
  id identifier title description priority estimate url createdAt updatedAt completedAt canceledAt startedAt dueDate
  state { name type }
  assignee { id name displayName email }
  creator { id name displayName email }
  labels(first: 50) { nodes { name } }
  parent { id }
  cycle { id }
  project { name }
  attachments(first: 10) { nodes { id } }
  comments(first: 50) { nodes { id body createdAt updatedAt user { id name displayName email } } pageInfo { hasNextPage endCursor } }
  relations(first: 50) { nodes { type relatedIssue { id } } }
`

export interface LinearClientOptions { token: string; fetchImpl?: typeof fetch; sleep?: ToolHttpOptions['sleep']; retries?: number; baseUrl?: string }

export class LinearClient implements SourceAdapter {
  readonly http: ToolHttp
  private sleep: (ms: number) => Promise<void>
  constructor(opts: LinearClientOptions) {
    this.http = new ToolHttp({
      provider: 'Linear', baseUrl: opts.baseUrl ?? 'https://api.linear.app/graphql',
      // Personal API keys are sent as-is (no "Bearer" prefix).
      headers: { Authorization: opts.token.trim() }, fetchImpl: opts.fetchImpl, sleep: opts.sleep, retries: opts.retries,
    })
    this.sleep = this.http.sleep
  }

  /** One GraphQL call; handles Linear's RATELIMITED errors (returned with HTTP 400) by waiting and retrying. */
  async query<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.http.request('POST', '', { body: { query, variables }, okStatuses: [400] })
      const errors: any[] = res.json?.errors ?? []
      const code = (e: any) => e?.extensions?.code ?? e?.extensions?.type
      if (errors.some((e) => /RATELIMITED/i.test(String(code(e))))) {
        if (attempt >= 5) throw new ToolHttpError(429, 'Linear rate limit exceeded; retries exhausted. Try again in a few minutes.')
        await this.sleep(this.http.waitMs(new Response(null, { headers: res.headers }), attempt + 1))
        continue
      }
      if (errors.some((e) => /AUTHENTICATION|FORBIDDEN/i.test(String(code(e))))) throw new ToolHttpError(401, 'Linear rejected the credentials. Check the API key.')
      if (errors.length && !res.json?.data) throw new ToolHttpError(res.status, `Linear query failed: ${String(errors[0]?.message ?? 'unknown error').slice(0, 200)}`)
      return res.json.data as T
    }
  }

  async viewer() {
    const d = await this.query<{ viewer: { name: string; email: string } }>('query { viewer { name email } }')
    return { name: d.viewer.name, email: d.viewer.email ?? null }
  }

  private async teams(): Promise<any[]> {
    const out: any[] = []
    let after: string | null = null
    for (;;) {
      const d: any = await this.query('query($after: String) { teams(first: 50, after: $after) { nodes { id key name description } pageInfo { hasNextPage endCursor } } }', { after })
      out.push(...d.teams.nodes)
      if (!d.teams.pageInfo.hasNextPage) return out
      after = d.teams.pageInfo.endCursor
    }
  }

  async containers(): Promise<ToolContainer[]> {
    // Linear exposes no cheap total, so the issue count stays unknown until the preview.
    return (await this.teams()).map((t) => ({ id: String(t.id), name: String(t.name), group: null, issueCount: null, suggestedKey: String(t.key || deriveKey(t.name)) }))
  }

  private async paged<T>(field: string, teamId: string, selection: string, pageSize = 50): Promise<T[]> {
    const out: T[] = []
    let after: string | null = null
    for (;;) {
      const d: any = await this.query(
        `query($id: String!, $after: String) { team(id: $id) { ${field}(first: ${pageSize}, after: $after) { nodes { ${selection} } pageInfo { hasNextPage endCursor } } } }`,
        { id: teamId, after },
      )
      const conn = d.team?.[field]
      out.push(...(conn?.nodes ?? []))
      if (!conn?.pageInfo?.hasNextPage) return out
      after = conn.pageInfo.endCursor
    }
  }

  private async moreComments(issueId: string, after: string): Promise<ToolComment[]> {
    const out: ToolComment[] = []
    let cursor: string | null = after
    while (cursor) {
      const d: any = await this.query(
        'query($id: String!, $after: String) { issue(id: $id) { comments(first: 50, after: $after) { nodes { id body createdAt updatedAt user { id name displayName email } } pageInfo { hasNextPage endCursor } } } }',
        { id: issueId, after: cursor },
      )
      const conn = d.issue?.comments
      out.push(...(conn?.nodes ?? []).map(mapComment))
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null
    }
    return out
  }

  async *extract(opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem> {
    const wanted = opts.containerIds?.length ? new Set(opts.containerIds) : null
    const teams = (await this.teams()).filter((t) => !wanted || wanted.has(String(t.id)))
    for (const t of teams) {
      if (await ctx.isCancelled()) return
      const teamId = String(t.id)
      const states = await this.paged<any>('states', teamId, 'name type position')
      states.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      const cycles = await this.paged<any>('cycles', teamId, 'id number name description startsAt endsAt completedAt')
      const lprojects = await this.paged<any>('projects', teamId, 'name')
      const project: ToolProject = {
        id: teamId, suggestedKey: t.key ?? null, name: String(t.name), description: t.description ?? null,
        statuses: states.map((s) => ({ name: String(s.name), category: linearCategory(s.type) })),
        sprints: cycles.map((c) => ({
          id: String(c.id), name: String(c.name || `Cycle ${c.number}`), goal: c.description ?? null, state: cycleState(c),
          startDate: date(c.startsAt), endDate: date(c.endsAt), completeDate: date(c.completedAt),
        })),
        components: lprojects.map((p) => String(p.name)),
      }
      yield { kind: 'project', project }

      let after: string | null = null
      for (;;) {
        if (await ctx.isCancelled()) return
        const filter = opts.updatedSince ? `, filter: { updatedAt: { gte: "${opts.updatedSince.toISOString()}" } }` : ''
        const d: any = await this.query(
          `query($id: String!, $after: String) { team(id: $id) { issues(first: 25, after: $after, includeArchived: true${filter}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
          { id: teamId, after },
        )
        const conn = d.team?.issues
        for (const raw of conn?.nodes ?? []) {
          const issue = mapLinearIssue(raw, teamId, ctx.unsupported)
          if (opts.includeComments !== false && raw.comments?.pageInfo?.hasNextPage) {
            issue.comments.push(...(await this.moreComments(String(raw.id), raw.comments.pageInfo.endCursor)))
          }
          if (raw.labels?.nodes?.length >= 50) ctx.unsupported.add('labels beyond the first 50 per issue')
          yield { kind: 'issue', issue }
        }
        if (!conn?.pageInfo?.hasNextPage) break
        after = conn.pageInfo.endCursor
      }
    }
  }
}
