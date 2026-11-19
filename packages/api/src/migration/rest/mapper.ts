/** Pure helpers that turn Jira REST payloads into normalized records. */

export interface JiraUserRef {
  accountId?: string
  name?: string
  key?: string
  emailAddress?: string
  displayName?: string
}

export interface NormalizedUser {
  username: string
  email: string
  displayName: string
}

/** Jira Cloud may hide emails; Server uses `name`. Produce a stable identity for matching. */
export function normalizeUser(u: JiraUserRef | null | undefined): NormalizedUser | null {
  if (!u) return null
  const id = u.name || u.key || u.accountId
  if (!id && !u.emailAddress) return null
  const email = (u.emailAddress || `${id}@migrated.invalid`).toLowerCase()
  const base = (u.name || (u.emailAddress ? u.emailAddress.split('@')[0] : '') || u.accountId || 'user')
  return {
    username: String(base).slice(0, 200),
    email: email.slice(0, 255),
    displayName: (u.displayName || base).slice(0, 255),
  }
}

export function parseKey(key: string): { project: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(key)
  return m ? { project: m[1], number: Number(m[2]) } : null
}

/** Issue fields requested from Jira (kept explicit to avoid downloading everything). */
export const ISSUE_FIELDS = [
  'summary', 'description', 'issuetype', 'status', 'priority', 'resolution', 'assignee', 'reporter',
  'created', 'updated', 'resolutiondate', 'duedate', 'labels', 'components', 'fixVersions', 'versions',
  'parent', 'issuelinks', 'comment', 'worklog', 'attachment', 'environment',
  'timeoriginalestimate', 'timeestimate', 'timespent',
].join(',')

export interface NormalizedIssue {
  key: string
  jiraId: string
  summary: string
  description: string | null
  issueType: { name: string; subtask: boolean }
  status: { name: string; category: 'todo' | 'in_progress' | 'done' }
  priority: string | null
  resolution: string | null
  assignee: NormalizedUser | null
  reporter: NormalizedUser | null
  created: Date
  updated: Date
  resolved: Date | null
  dueDate: Date | null
  labels: string[]
  components: string[]
  fixVersions: string[]
  affectsVersions: string[]
  parentKey: string | null
  links: Array<{ type: { name: string; inward: string; outward: string }; outwardKey: string }>
  comments: any[]
  commentsTotal: number
  worklogs: any[]
  worklogsTotal: number
  attachments: Array<{ filename: string; size: number; mimeType: string; content: string; author: NormalizedUser | null; created: Date }>
  environment: string | null
  timeEstimate: number | null
  timeSpent: number | null
  /** Filled in by the importer from the Jira story-points custom field. */
  storyPoints?: number | null
  history: Array<{ at: Date; author: NormalizedUser | null; field: string; from: string | null; to: string | null }>
}

const date = (v: any): Date | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function statusCategory(s: any): 'todo' | 'in_progress' | 'done' {
  const key = s?.statusCategory?.key
  if (key === 'done') return 'done'
  if (key === 'indeterminate') return 'in_progress'
  return 'todo'
}

export function normalizeIssue(raw: any): NormalizedIssue {
  const f = raw.fields ?? {}
  const links: NormalizedIssue['links'] = []
  for (const l of f.issuelinks ?? []) {
    // Only record the outward side; each link appears on both issues and would otherwise be duplicated.
    if (l.outwardIssue?.key && l.type) {
      links.push({
        type: { name: l.type.name, inward: l.type.inward ?? l.type.name, outward: l.type.outward ?? l.type.name },
        outwardKey: l.outwardIssue.key,
      })
    }
  }
  const history: NormalizedIssue['history'] = []
  for (const h of raw.changelog?.histories ?? []) {
    const at = date(h.created)
    if (!at) continue
    for (const item of h.items ?? []) {
      history.push({
        at, author: normalizeUser(h.author), field: String(item.field ?? ''),
        from: item.fromString ?? null, to: item.toString ?? null,
      })
    }
  }
  return {
    key: raw.key,
    jiraId: String(raw.id),
    summary: String(f.summary ?? '').slice(0, 500),
    description: f.description ?? null,
    issueType: { name: f.issuetype?.name ?? 'Task', subtask: !!f.issuetype?.subtask },
    status: { name: f.status?.name ?? 'To Do', category: statusCategory(f.status) },
    priority: f.priority?.name ?? null,
    resolution: f.resolution?.name ?? null,
    assignee: normalizeUser(f.assignee),
    reporter: normalizeUser(f.reporter),
    created: date(f.created) ?? new Date(),
    updated: date(f.updated) ?? new Date(),
    resolved: date(f.resolutiondate),
    dueDate: date(f.duedate),
    labels: (f.labels ?? []).map(String),
    components: (f.components ?? []).map((c: any) => c.name),
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
    affectsVersions: (f.versions ?? []).map((v: any) => v.name),
    parentKey: f.parent?.key ?? null,
    links,
    comments: f.comment?.comments ?? [],
    commentsTotal: f.comment?.total ?? (f.comment?.comments?.length ?? 0),
    worklogs: f.worklog?.worklogs ?? [],
    worklogsTotal: f.worklog?.total ?? (f.worklog?.worklogs?.length ?? 0),
    attachments: (f.attachment ?? []).map((a: any) => ({
      filename: a.filename, size: a.size ?? 0, mimeType: a.mimeType || 'application/octet-stream',
      content: a.content, author: normalizeUser(a.author), created: date(a.created) ?? new Date(),
    })),
    environment: f.environment ?? null,
    timeEstimate: f.timeoriginalestimate ?? null,
    timeSpent: f.timespent ?? null,
    history,
  }
}
