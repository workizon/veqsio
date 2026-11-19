import { ToolHttp, type ToolHttpOptions } from './http'
import {
  guessCategory, mapPriorityName,
  type ExtractContext, type ExtractOptions, type SourceAdapter, type SourceInfo, type ToolComment, type ToolContainer, type ToolIssue, type ToolItem, type ToolStatus, type ToolUser,
} from './model'
import { deriveKey } from './engine'

export const ASANA_INFO: SourceInfo = {
  id: 'asana',
  name: 'Asana',
  mode: 'live',
  tokenHelp: 'Asana > profile photo > Settings > Apps > Service accounts or Developer apps > Personal access token.',
  maps: [
    'Projects become projects (key derived from the name unless you set one)',
    'Sections become statuses and board columns; completed tasks move to "Done"',
    'Tasks and subtasks (parent/sub-task), assignee and creator matched by e-mail',
    'Comments (stories of type comment), tags as labels, due and start dates, estimated and actual time',
    'Custom fields: a "Priority" enum becomes the priority, a numeric "Story points"/"Estimate" field becomes story points',
  ],
  unsupported: [
    'Other custom fields', 'Attachments', 'Followers', 'Task dependencies', 'Likes', 'Portfolios and goals', 'Approvals and rules', 'Activity history (system stories)',
  ],
}

const OPT_FIELDS = [
  'name', 'notes', 'completed', 'completed_at', 'created_at', 'modified_at', 'due_on', 'due_at', 'start_on', 'resource_subtype', 'num_subtasks',
  'permalink_url', 'estimated_minutes', 'actual_time_minutes',
  'assignee.name', 'assignee.email', 'created_by.name', 'created_by.email',
  'memberships.project.gid', 'memberships.section.name', 'tags.name',
  'custom_fields.name', 'custom_fields.type', 'custom_fields.display_value', 'custom_fields.number_value', 'custom_fields.enum_value.name',
].join(',')

const date = (v: unknown): Date | null => {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export function asanaUser(u: any): ToolUser | null {
  if (!u) return null
  return { externalId: u.gid, email: u.email ?? null, name: u.name ?? null }
}

export function sectionName(raw: string | undefined | null): string {
  const n = (raw ?? '').trim()
  return !n || /^untitled section$/i.test(n) ? 'To Do' : n.slice(0, 100)
}

/** Pure mapper for one task payload (subtasks included by the caller through parentId). */
export function mapAsanaTask(raw: any, projectGid: string, parentId: string | null, unsupported: ExtractContext['unsupported']): ToolIssue {
  const membership = (raw.memberships ?? []).find((m: any) => m.project?.gid === projectGid)
  const completed = !!raw.completed
  let status: ToolStatus
  if (completed) {
    const sec = membership?.section?.name ? sectionName(membership.section.name) : null
    status = sec && guessCategory(sec) === 'done' ? { name: sec, category: 'done' } : { name: 'Done', category: 'done' }
  } else {
    const name = membership?.section?.name ? sectionName(membership.section.name) : 'To Do'
    status = { name, category: guessCategory(name) === 'done' ? 'in_progress' : guessCategory(name) }
  }

  let priority: string | null = null
  let storyPoints: number | null = null
  for (const cf of raw.custom_fields ?? []) {
    const name = String(cf.name ?? '')
    const hasValue = cf.display_value !== null && cf.display_value !== undefined && cf.display_value !== ''
    if (!hasValue) continue
    if (/priority/i.test(name) && cf.enum_value?.name) priority = mapPriorityName(cf.enum_value.name)
    else if (/^(story ?points?|points|estimate|effort)$/i.test(name) && typeof cf.number_value === 'number') storyPoints = cf.number_value
    else unsupported.add(`custom field "${name}"`)
  }
  if (raw.resource_subtype === 'milestone') unsupported.add('milestone type (imported as issue type Milestone)')
  if (raw.resource_subtype === 'approval') unsupported.add('approval status of approval tasks')

  return {
    id: String(raw.gid),
    identifier: null,
    projectId: projectGid,
    title: String(raw.name ?? ''),
    description: raw.notes ? String(raw.notes) : null,
    type: raw.resource_subtype === 'milestone' ? 'Milestone' : parentId ? 'Sub-task' : 'Task',
    isSubtask: !!parentId,
    status,
    priority,
    resolution: completed ? 'Done' : null,
    assignee: asanaUser(raw.assignee),
    creator: asanaUser(raw.created_by),
    createdAt: date(raw.created_at),
    updatedAt: date(raw.modified_at),
    resolvedAt: date(raw.completed_at),
    dueDate: date(raw.due_at) ?? date(raw.due_on),
    startDate: date(raw.start_on),
    labels: (raw.tags ?? []).map((t: any) => String(t.name)).filter(Boolean),
    components: [],
    parentId,
    storyPoints,
    timeEstimateSeconds: typeof raw.estimated_minutes === 'number' ? raw.estimated_minutes * 60 : null,
    timeSpentSeconds: typeof raw.actual_time_minutes === 'number' ? raw.actual_time_minutes * 60 : null,
    comments: [],
    links: [],
    url: raw.permalink_url ?? null,
  }
}

export interface AsanaClientOptions { token: string; fetchImpl?: typeof fetch; sleep?: ToolHttpOptions['sleep']; retries?: number; baseUrl?: string }

const MAX_SUBTASK_DEPTH = 5

export class AsanaClient implements SourceAdapter {
  readonly http: ToolHttp
  constructor(opts: AsanaClientOptions) {
    this.http = new ToolHttp({
      provider: 'Asana', baseUrl: opts.baseUrl ?? 'https://app.asana.com/api/1.0',
      headers: { Authorization: `Bearer ${opts.token.trim()}` }, fetchImpl: opts.fetchImpl, sleep: opts.sleep, retries: opts.retries,
    })
  }

  /** Follows next_page.uri until exhausted. */
  async *list(path: string, query: Record<string, string | number | boolean | undefined> = {}): AsyncGenerator<any> {
    let res = await this.http.request('GET', path, { query: { limit: 100, ...query } })
    for (let pages = 0; pages < 100_000; pages++) {
      for (const row of res.json?.data ?? []) yield row
      const next = res.json?.next_page?.uri
      if (!next) return
      res = await this.http.request('GET', next)
    }
  }

  async viewer() {
    const r = await this.http.request('GET', 'users/me', { query: { opt_fields: 'name,email,workspaces.name' } })
    return { name: String(r.json?.data?.name ?? ''), email: r.json?.data?.email ?? null }
  }

  async containers(opts: ExtractOptions): Promise<ToolContainer[]> {
    const me = await this.http.request('GET', 'users/me', { query: { opt_fields: 'workspaces.name' } })
    let workspaces: Array<{ gid: string; name: string }> = me.json?.data?.workspaces ?? []
    if (opts.workspaceId) workspaces = workspaces.filter((w) => w.gid === opts.workspaceId)
    const out: ToolContainer[] = []
    for (const w of workspaces) {
      for await (const p of this.list('projects', { workspace: w.gid, archived: false, opt_fields: 'name' })) {
        let count: number | null = null
        try {
          const c = await this.http.request('GET', `projects/${encodeURIComponent(p.gid)}/task_counts`, { query: { opt_fields: 'num_tasks' } })
          count = typeof c.json?.data?.num_tasks === 'number' ? c.json.data.num_tasks : null
        } catch (e: any) { if (e?.status === 401 || e?.status === 403) throw e }
        out.push({ id: String(p.gid), name: String(p.name), group: w.name, issueCount: count, suggestedKey: deriveKey(String(p.name)) })
        if (out.length >= 1000) return out
      }
    }
    return out
  }

  private async comments(taskGid: string): Promise<ToolComment[]> {
    const out: ToolComment[] = []
    for await (const s of this.list(`tasks/${encodeURIComponent(taskGid)}/stories`, { opt_fields: 'resource_subtype,text,created_at,created_by.name,created_by.email' })) {
      if (s.resource_subtype !== 'comment_added' || !s.text) continue
      out.push({ id: String(s.gid), author: asanaUser(s.created_by), body: String(s.text), createdAt: date(s.created_at) })
    }
    return out
  }

  private async *tasks(projectGid: string, parentGid: string | null, depth: number, opts: ExtractOptions, ctx: ExtractContext, seen: Set<string>): AsyncGenerator<ToolItem> {
    const path = parentGid ? `tasks/${encodeURIComponent(parentGid)}/subtasks` : 'tasks'
    const query: Record<string, string> = { opt_fields: OPT_FIELDS }
    if (!parentGid) {
      query.project = projectGid
      query.completed_since = '1970-01-01T00:00:00.000Z' // include completed tasks
      if (opts.updatedSince) query.modified_since = opts.updatedSince.toISOString()
    }
    for await (const raw of this.list(path, query)) {
      if (await ctx.isCancelled()) return
      if (seen.has(String(raw.gid))) continue
      seen.add(String(raw.gid))
      const issue = mapAsanaTask(raw, projectGid, parentGid, ctx.unsupported)
      if (opts.includeComments !== false) issue.comments = await this.comments(String(raw.gid))
      yield { kind: 'issue', issue }
      if ((raw.num_subtasks ?? 0) > 0) {
        if (depth >= MAX_SUBTASK_DEPTH) yield { kind: 'warning', message: `Subtasks nested deeper than ${MAX_SUBTASK_DEPTH} levels were not imported` }
        else yield* this.tasks(projectGid, String(raw.gid), depth + 1, opts, ctx, seen)
      }
    }
  }

  async *extract(opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem> {
    const wanted = opts.containerIds?.length ? new Set(opts.containerIds) : null
    const containers = (await this.containers(opts)).filter((c) => !wanted || wanted.has(c.id))
    const seen = new Set<string>()
    for (const c of containers) {
      if (await ctx.isCancelled()) return
      const detail = (await this.http.request('GET', `projects/${encodeURIComponent(c.id)}`, { query: { opt_fields: 'name,notes,owner.name,owner.email' } })).json?.data ?? {}
      const statuses: ToolStatus[] = []
      for await (const s of this.list(`projects/${encodeURIComponent(c.id)}/sections`, { opt_fields: 'name' })) {
        const name = sectionName(s.name)
        if (!statuses.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          const cat = guessCategory(name)
          statuses.push({ name, category: cat })
        }
      }
      if (!statuses.length) statuses.push({ name: 'To Do', category: 'todo' })
      if (!statuses.some((s) => s.category === 'done')) statuses.push({ name: 'Done', category: 'done' })
      else if (!statuses.some((s) => s.name.toLowerCase() === 'done')) statuses.push({ name: 'Done', category: 'done' })
      yield {
        kind: 'project',
        project: { id: c.id, suggestedKey: c.suggestedKey, name: String(detail.name ?? c.name), description: detail.notes || null, lead: asanaUser(detail.owner), statuses, sprints: [], components: [] },
      }
      if (c.issueCount) yield { kind: 'total', count: c.issueCount }
      yield* this.tasks(c.id, null, 0, opts, ctx, seen)
    }
  }
}
