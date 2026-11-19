/**
 * Provider-neutral import model. Every source (Linear, Asana, ClickUp, generic JSON) is turned into a stream of
 * ToolItem records by its own adapter; engine.ts writes them to Veqsio (or only counts them for a dry run).
 */

export type ToolSourceId = 'linear' | 'asana' | 'clickup' | 'json'
export const TOOL_SOURCES: readonly ToolSourceId[] = ['linear', 'asana', 'clickup', 'json']

export type StatusCategory = 'todo' | 'in_progress' | 'done'

export interface ToolUser {
  /** Provider id; only used to build a stable placeholder identity when no e-mail is exposed. */
  externalId?: string | null
  email?: string | null
  name?: string | null
}

export interface ToolComment {
  id: string
  author: ToolUser | null
  body: string
  createdAt: Date | null
  updatedAt?: Date | null
}

export interface ToolStatus { name: string; category: StatusCategory }

export interface ToolSprint {
  id: string
  name: string
  goal?: string | null
  state: 'future' | 'active' | 'closed'
  startDate?: Date | null
  endDate?: Date | null
  completeDate?: Date | null
}

export interface ToolProject {
  /** Provider id of the container (Linear team, Asana project, ClickUp space/list). */
  id: string
  /** Suggested project key (e.g. the Linear team key); made unique by the engine unless the admin overrides it. */
  suggestedKey?: string | null
  name: string
  description?: string | null
  lead?: ToolUser | null
  /** Workflow states / sections / statuses in board order. They become statuses and board columns. */
  statuses: ToolStatus[]
  sprints: ToolSprint[]
  components: string[]
}

export type LinkKind = 'Blocks' | 'Relates' | 'Duplicate'

export interface ToolIssue {
  id: string
  /** Human readable id in the source tool (ENG-12); informational. */
  identifier?: string | null
  projectId: string
  title: string
  description?: string | null
  type?: string | null
  isSubtask?: boolean
  status: ToolStatus
  /** Veqsio priority name (Highest/High/Medium/Low/Lowest) or null. */
  priority?: string | null
  /** Resolution name for finished issues (Done / Won't Do). */
  resolution?: string | null
  assignee?: ToolUser | null
  creator?: ToolUser | null
  createdAt?: Date | null
  updatedAt?: Date | null
  resolvedAt?: Date | null
  dueDate?: Date | null
  startDate?: Date | null
  labels: string[]
  components: string[]
  parentId?: string | null
  storyPoints?: number | null
  timeEstimateSeconds?: number | null
  timeSpentSeconds?: number | null
  sprintId?: string | null
  comments: ToolComment[]
  /** Outgoing links: this issue -> target (by provider id). */
  links: Array<{ targetId: string; kind: LinkKind }>
  url?: string | null
}

export type ToolItem =
  | { kind: 'project'; project: ToolProject }
  | { kind: 'issue'; issue: ToolIssue }
  /** Adds to the expected number of issues (progress bar). */
  | { kind: 'total'; count: number }
  | { kind: 'warning'; message: string }

/** Collects "this data exists in the source but Veqsio cannot hold it" counts. */
export class UnsupportedCollector {
  readonly counts = new Map<string, number>()
  add(field: string, n = 1) { this.counts.set(field, (this.counts.get(field) ?? 0) + n) }
}

export interface ExtractContext {
  unsupported: UnsupportedCollector
  /** Cooperative cancel check; adapters call it between pages. */
  isCancelled: () => boolean | Promise<boolean>
}

export interface ToolContainer {
  id: string
  name: string
  /** Group shown above the container in the UI (Asana: workspace, ClickUp: space). */
  group?: string | null
  issueCount: number | null
  suggestedKey: string
  /** Set by the route: a Veqsio project already exists for this container (re-run updates it). */
  existsInVeqsio?: boolean
}

export interface ToolViewer { name: string; email: string | null }

/** Selection and per-source options understood by the adapters. */
export interface ExtractOptions {
  /** Container ids to import. Empty/undefined = everything. */
  containerIds?: string[]
  includeComments?: boolean
  /** ClickUp: one Veqsio project per space (default) or per list. */
  groupBy?: 'space' | 'list'
  /** Asana: workspace gid (defaults to the first). ClickUp: workspace id. */
  workspaceId?: string
  /** Only issues changed since this instant (incremental re-sync). */
  updatedSince?: Date
}

export interface SourceAdapter {
  viewer(): Promise<ToolViewer>
  containers(opts: ExtractOptions): Promise<ToolContainer[]>
  extract(opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem>
}

/** Static description used by the UI and the documentation. */
export interface SourceInfo {
  id: ToolSourceId
  name: string
  mode: 'live' | 'file'
  tokenHelp?: string
  maps: string[]
  unsupported: string[]
}

const DONE_RE = /\b(done|closed|complete|completed|finished|resolved|shipped|released|cancel+ed|won'?t)\b/i
const PROGRESS_RE = /(progress|doing|review|testing|\bqa\b|active|started|wip|develop)/i

/** Best-effort status category from a board column / section / status name. */
export function guessCategory(name: string): StatusCategory {
  if (DONE_RE.test(name)) return 'done'
  if (PROGRESS_RE.test(name)) return 'in_progress'
  return 'todo'
}

/** Map free-form priority wording of any tool to Veqsio's Highest..Lowest. */
export function mapPriorityName(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name.trim().toLowerCase()
  if (/^(urgent|critical|highest|blocker|p0|1)$/.test(n)) return 'Highest'
  if (/^(high|major|p1|2)$/.test(n)) return 'High'
  if (/^(medium|normal|med|moderate|p2|3)$/.test(n)) return 'Medium'
  if (/^(low|minor|p3|4)$/.test(n)) return 'Low'
  if (n === 'none') return null
  if (/^(lowest|trivial|p4|5)$/.test(n)) return 'Lowest'
  return name.trim().slice(0, 100)
}
