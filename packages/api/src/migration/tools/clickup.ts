import { ToolHttp, type ToolHttpOptions } from './http'
import {
  guessCategory, mapPriorityName,
  type ExtractContext, type ExtractOptions, type SourceAdapter, type SourceInfo, type StatusCategory, type ToolComment, type ToolContainer, type ToolIssue, type ToolItem, type ToolStatus, type ToolUser,
} from './model'
import { deriveKey } from './engine'

export const CLICKUP_INFO: SourceInfo = {
  id: 'clickup',
  name: 'ClickUp',
  mode: 'live',
  tokenHelp: 'ClickUp > avatar > Settings > Apps > API Token (starts with pk_).',
  maps: [
    'Spaces become projects (or one project per list); folders and lists become components',
    'Statuses (with their open/custom/closed type) become statuses and board columns',
    'Tasks and subtasks, assignee (first assignee) and creator matched by e-mail',
    'Comments, tags as labels, priority, due and start dates, time estimate and time spent, points as story points',
    'Dependencies (blocking) and linked tasks as issue links',
  ],
  unsupported: [
    'Additional assignees beyond the first', 'Checklists', 'Custom fields', 'Attachments', 'Sprint folders (Sprints ClickApp)', 'Docs and whiteboards',
    'Time tracking entries', 'Watchers', 'Task templates and automations',
  ],
}

const ms = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n)
  return Number.isNaN(d.getTime()) ? null : d
}

export const titleCase = (s: string) => s.trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 100)

export function clickupUser(u: any): ToolUser | null {
  if (!u) return null
  return { externalId: u.id !== undefined ? String(u.id) : null, email: u.email ?? null, name: u.username ?? null }
}

export function clickupStatus(s: { status?: string; type?: string } | null | undefined): ToolStatus {
  const name = titleCase(String(s?.status || 'to do'))
  let category: StatusCategory
  if (s?.type === 'closed' || s?.type === 'done') category = 'done'
  else if (s?.type === 'open') category = 'todo'
  else category = guessCategory(name) === 'todo' ? 'in_progress' : guessCategory(name)
  return { name, category }
}

export function mapClickupTask(raw: any, projectId: string, componentName: string | null, unsupported: ExtractContext['unsupported']): ToolIssue {
  const id = String(raw.id)
  const status = clickupStatus(raw.status)
  const parentId = raw.parent ? String(raw.parent) : null
  const assignees: any[] = raw.assignees ?? []
  if (assignees.length > 1) unsupported.add('additional assignees (only the first is imported)', 1)
  if (raw.checklists?.length) unsupported.add('checklists', raw.checklists.length)
  if (raw.attachments?.length) unsupported.add('attachments', raw.attachments.length)
  const cfWithValue = (raw.custom_fields ?? []).filter((f: any) => f.value !== undefined && f.value !== null && f.value !== '')
  if (cfWithValue.length) unsupported.add('custom fields', cfWithValue.length)

  const links: ToolIssue['links'] = []
  for (const d of raw.dependencies ?? []) {
    // "task_id waits on depends_on": the blocker owns the outgoing link, so only record it from the blocker's side.
    if (String(d.depends_on) === id && d.task_id) links.push({ targetId: String(d.task_id), kind: 'Blocks' })
  }
  for (const l of raw.linked_tasks ?? []) {
    const other = String(l.task_id) === id ? l.link_id : l.task_id
    if (other && String(other) !== id) links.push({ targetId: String(other), kind: 'Relates' })
  }
  const estimate = Number(raw.time_estimate)
  const spent = Number(raw.time_spent)
  return {
    id,
    identifier: raw.custom_id ?? id,
    projectId,
    title: String(raw.name ?? ''),
    description: raw.markdown_description || raw.text_content || raw.description || null,
    type: parentId ? 'Sub-task' : 'Task',
    isSubtask: !!parentId,
    status,
    priority: mapPriorityName(raw.priority?.priority ?? null),
    resolution: status.category === 'done' ? 'Done' : null,
    assignee: clickupUser(assignees[0]),
    creator: clickupUser(raw.creator),
    createdAt: ms(raw.date_created),
    updatedAt: ms(raw.date_updated),
    resolvedAt: ms(raw.date_done) ?? ms(raw.date_closed),
    dueDate: ms(raw.due_date),
    startDate: ms(raw.start_date),
    labels: (raw.tags ?? []).map((t: any) => String(t.name)).filter(Boolean),
    components: componentName ? [componentName] : [],
    parentId,
    storyPoints: typeof raw.points === 'number' ? raw.points : null,
    timeEstimateSeconds: Number.isFinite(estimate) && estimate > 0 ? Math.round(estimate / 1000) : null,
    timeSpentSeconds: Number.isFinite(spent) && spent > 0 ? Math.round(spent / 1000) : null,
    comments: [],
    links,
    url: raw.url ?? null,
  }
}

interface ListInfo { id: string; name: string; folder: string | null; taskCount: number | null }
interface SpaceInfo { id: string; name: string; workspace: string; statuses: Array<{ status: string; type: string }>; lists: ListInfo[] }

export interface ClickupClientOptions { token: string; fetchImpl?: typeof fetch; sleep?: ToolHttpOptions['sleep']; retries?: number; baseUrl?: string }

const COMMENT_PAGE = 25

export class ClickupClient implements SourceAdapter {
  readonly http: ToolHttp
  constructor(opts: ClickupClientOptions) {
    this.http = new ToolHttp({
      provider: 'ClickUp', baseUrl: opts.baseUrl ?? 'https://api.clickup.com/api/v2',
      headers: { Authorization: opts.token.trim() }, fetchImpl: opts.fetchImpl, sleep: opts.sleep, retries: opts.retries,
    })
  }

  private get(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.http.request('GET', path, { query }).then((r) => r.json ?? {})
  }

  async viewer() {
    const r = await this.get('user')
    return { name: String(r.user?.username ?? ''), email: r.user?.email ?? null }
  }

  private async spaces(opts: ExtractOptions): Promise<SpaceInfo[]> {
    let teams: any[] = (await this.get('team')).teams ?? []
    if (opts.workspaceId) teams = teams.filter((t) => String(t.id) === opts.workspaceId)
    const out: SpaceInfo[] = []
    for (const t of teams) {
      const spaces: any[] = (await this.get(`team/${encodeURIComponent(t.id)}/space`, { archived: false })).spaces ?? []
      for (const s of spaces) {
        const lists: ListInfo[] = []
        const folders: any[] = (await this.get(`space/${encodeURIComponent(s.id)}/folder`, { archived: false })).folders ?? []
        for (const f of folders) for (const l of f.lists ?? []) lists.push({ id: String(l.id), name: String(l.name), folder: String(f.name), taskCount: typeof l.task_count === 'number' ? l.task_count : null })
        const loose: any[] = (await this.get(`space/${encodeURIComponent(s.id)}/list`, { archived: false })).lists ?? []
        for (const l of loose) lists.push({ id: String(l.id), name: String(l.name), folder: null, taskCount: typeof l.task_count === 'number' ? l.task_count : null })
        out.push({ id: String(s.id), name: String(s.name), workspace: String(t.name ?? t.id), statuses: s.statuses ?? [], lists })
      }
    }
    return out
  }

  async containers(opts: ExtractOptions): Promise<ToolContainer[]> {
    const spaces = await this.spaces(opts)
    const sum = (ls: ListInfo[]) => (ls.every((l) => l.taskCount !== null) ? ls.reduce((a, l) => a + (l.taskCount ?? 0), 0) : null)
    if (opts.groupBy === 'list') {
      return spaces.flatMap((s) => s.lists.map((l) => ({
        id: `list:${l.id}`, name: l.name, group: `${s.workspace} / ${s.name}${l.folder ? ` / ${l.folder}` : ''}`, issueCount: l.taskCount, suggestedKey: deriveKey(l.name),
      })))
    }
    return spaces.map((s) => ({ id: `space:${s.id}`, name: s.name, group: s.workspace, issueCount: sum(s.lists), suggestedKey: deriveKey(s.name) }))
  }

  private async comments(taskId: string): Promise<ToolComment[]> {
    const out: ToolComment[] = []
    const seen = new Set<string>()
    let query: Record<string, string | undefined> = {}
    for (let page = 0; page < 1000; page++) {
      const r = await this.get(`task/${encodeURIComponent(taskId)}/comment`, query)
      const rows: any[] = r.comments ?? []
      let fresh = 0
      for (const c of rows) {
        const id = String(c.id)
        if (seen.has(id)) continue
        seen.add(id); fresh++
        const text = String(c.comment_text ?? '').trim()
        if (text) out.push({ id, author: clickupUser(c.user), body: text, createdAt: ms(c.date) })
      }
      if (rows.length < COMMENT_PAGE || fresh === 0) break
      const last = rows[rows.length - 1]
      query = { start: String(last.date), start_id: String(last.id) }
    }
    return out
  }

  private async *listTasks(list: ListInfo, projectId: string, component: string | null, opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem> {
    for (let page = 0; page < 100_000; page++) {
      if (await ctx.isCancelled()) return
      const r = await this.get(`list/${encodeURIComponent(list.id)}/task`, {
        page, include_closed: true, subtasks: true, archived: false, include_markdown_description: true,
        date_updated_gt: opts.updatedSince ? opts.updatedSince.getTime() : undefined,
      })
      const tasks: any[] = r.tasks ?? []
      for (const raw of tasks) {
        const issue = mapClickupTask(raw, projectId, component, ctx.unsupported)
        if (opts.includeComments !== false) issue.comments = await this.comments(issue.id)
        yield { kind: 'issue', issue }
      }
      if (r.last_page === true || tasks.length === 0 || (r.last_page === undefined && tasks.length < 100)) return
    }
  }

  async *extract(opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem> {
    const wanted = opts.containerIds?.length ? new Set(opts.containerIds) : null
    const spaces = await this.spaces(opts)
    const byList = opts.groupBy === 'list'
    for (const s of spaces) {
      const statuses: ToolStatus[] = s.statuses.map((x) => clickupStatus(x))
      const compName = (l: ListInfo) => (l.folder ? `${l.folder} / ${l.name}` : l.name).slice(0, 255)
      if (byList) {
        for (const l of s.lists) {
          const id = `list:${l.id}`
          if (wanted && !wanted.has(id)) continue
          if (await ctx.isCancelled()) return
          yield { kind: 'project', project: { id, suggestedKey: deriveKey(l.name), name: l.name, description: `ClickUp list ${s.name}${l.folder ? ` / ${l.folder}` : ''} / ${l.name}`, statuses, sprints: [], components: [] } }
          if (l.taskCount) yield { kind: 'total', count: l.taskCount }
          yield* this.listTasks(l, id, null, opts, ctx)
        }
      } else {
        const id = `space:${s.id}`
        if (wanted && !wanted.has(id)) continue
        if (await ctx.isCancelled()) return
        yield { kind: 'project', project: { id, suggestedKey: deriveKey(s.name), name: s.name, description: null, statuses, sprints: [], components: s.lists.map(compName) } }
        const total = s.lists.every((l) => l.taskCount !== null) ? s.lists.reduce((a, l) => a + (l.taskCount ?? 0), 0) : 0
        if (total) yield { kind: 'total', count: total }
        for (const l of s.lists) yield* this.listTasks(l, id, compName(l), opts, ctx)
      }
    }
  }
}
