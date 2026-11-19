/** Pure helpers for saved views (types mirror the API in packages/api/src/views/config.ts). */

export const LAYOUTS = ['list', 'table', 'board', 'calendar', 'timeline'] as const
export type Layout = (typeof LAYOUTS)[number]
export const LAYOUT_LABELS: Record<Layout, string> = { list: 'List', table: 'Table', board: 'Board', calendar: 'Calendar', timeline: 'Timeline' }

export const GROUP_FIELDS = ['none', 'status', 'assignee', 'priority', 'type', 'label', 'sprint'] as const
export type GroupField = (typeof GROUP_FIELDS)[number]
export const GROUP_LABELS: Record<GroupField, string> = { none: 'None', status: 'Status', assignee: 'Assignee', priority: 'Priority', type: 'Type', label: 'Label', sprint: 'Sprint' }

export const COLUMN_IDS = [
  'key', 'summary', 'type', 'status', 'priority', 'assignee', 'reporter', 'project', 'labels', 'components',
  'fixVersions', 'sprint', 'storyPoints', 'created', 'updated', 'resolved', 'resolution', 'duedate', 'startdate',
] as const
export type ColumnId = (typeof COLUMN_IDS)[number]
export const COLUMN_LABELS: Record<ColumnId, string> = {
  key: 'Key', summary: 'Summary', type: 'Type', status: 'Status', priority: 'Priority', assignee: 'Assignee',
  reporter: 'Reporter', project: 'Project', labels: 'Labels', components: 'Components', fixVersions: 'Fix versions',
  sprint: 'Sprint', storyPoints: 'Story points', created: 'Created', updated: 'Updated', resolved: 'Resolved',
  resolution: 'Resolution', duedate: 'Due date', startdate: 'Start date',
}
/** Columns the server can sort by. */
export const SORTABLE: ReadonlySet<string> = new Set(['key', 'summary', 'type', 'status', 'priority', 'assignee', 'reporter', 'project', 'storyPoints', 'created', 'updated', 'resolved', 'duedate', 'startdate'])

export interface SortTerm { field: string; direction: 'asc' | 'desc' }
export interface ViewConfig {
  query: { jql: string; filters?: Record<string, unknown> }
  layout: Layout
  columns: ColumnId[]
  sort: SortTerm[]
  groupBy: GroupField
  subGroupBy: GroupField
  showEmptyGroups: boolean
  dateField: 'duedate' | 'startdate' | 'created' | 'updated'
}

export const DEFAULT_CONFIG: ViewConfig = {
  query: { jql: '' }, layout: 'list', columns: ['key', 'summary', 'type', 'status', 'priority', 'assignee', 'updated'],
  sort: [], groupBy: 'none', subGroupBy: 'none', showEmptyGroups: false, dateField: 'duedate',
}

export interface ViewGroup { key: string; label: string; count: number; issueIds: number[]; subGroups?: Array<{ key: string; label: string; count: number; issueIds: number[] }> }

/** Click on a column header: ascending, then descending, then back to the view's own order. */
export function nextSort(sort: SortTerm[], field: string): SortTerm[] {
  if (!SORTABLE.has(field)) return sort
  const cur = sort[0]?.field === field ? sort[0].direction : null
  if (cur === null) return [{ field, direction: 'asc' }]
  if (cur === 'asc') return [{ field, direction: 'desc' }]
  return []
}

export function toggleColumn(columns: ColumnId[], col: ColumnId): ColumnId[] {
  if (columns.includes(col)) return columns.length > 1 ? columns.filter((c) => c !== col) : columns
  return [...columns, col]
}

/** Moves a column by `delta` positions (display order); out of range moves are ignored. */
export function moveColumn(columns: ColumnId[], col: ColumnId, delta: number): ColumnId[] {
  const i = columns.indexOf(col)
  const j = i + delta
  if (i < 0 || j < 0 || j >= columns.length) return columns
  const out = [...columns]
  out.splice(i, 1)
  out.splice(j, 0, col)
  return out
}

export function configEquals(a: ViewConfig, b: ViewConfig): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}
function canon(c: ViewConfig) {
  return { ...c, query: { jql: c.query.jql.trim(), filters: c.query.filters ?? null } }
}

/** A group-by that makes no sense (sub-group equal to the group, or without a group) is reset. */
export function withGrouping(c: ViewConfig, patch: Partial<Pick<ViewConfig, 'groupBy' | 'subGroupBy'>>): ViewConfig {
  const next = { ...c, ...patch }
  if (next.groupBy === 'none' || next.subGroupBy === next.groupBy) next.subGroupBy = 'none'
  return next
}

/* ---------------- remembered settings per browser ---------------- */

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const LAST_PREFIX = 'veqsio-view-last:'

/** Settings (layout, grouping, columns ...) last used with a view in this browser, or null. */
export function loadLastUsed(store: KeyValueStore | null, viewId: string): ViewConfig | null {
  if (!store) return null
  try {
    const raw = store.getItem(LAST_PREFIX + viewId)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || !LAYOUTS.includes(v.layout) || !Array.isArray(v.columns)) return null
    return {
      ...DEFAULT_CONFIG, ...v,
      query: { jql: typeof v.query?.jql === 'string' ? v.query.jql : '', ...(v.query?.filters ? { filters: v.query.filters } : {}) },
      columns: v.columns.filter((c: unknown) => COLUMN_IDS.includes(c as ColumnId)).length ? v.columns.filter((c: unknown) => COLUMN_IDS.includes(c as ColumnId)) : DEFAULT_CONFIG.columns,
      groupBy: GROUP_FIELDS.includes(v.groupBy) ? v.groupBy : 'none',
      subGroupBy: GROUP_FIELDS.includes(v.subGroupBy) ? v.subGroupBy : 'none',
      sort: Array.isArray(v.sort) ? v.sort.filter((t: any) => t && SORTABLE.has(t.field) && (t.direction === 'asc' || t.direction === 'desc')).slice(0, 3) : [],
    }
  } catch { return null }
}

export function saveLastUsed(store: KeyValueStore | null, viewId: string, config: ViewConfig): void {
  try { store?.setItem(LAST_PREFIX + viewId, JSON.stringify(config)) } catch { /* storage full or blocked */ }
}

export function clearLastUsed(store: KeyValueStore | null, viewId: string): void {
  try { store?.removeItem(LAST_PREFIX + viewId) } catch { /* ignore */ }
}

/* ---------------- display helpers ---------------- */

export interface IssueLike { id: number; key: string; fields: Record<string, any> }

export function cellText(issue: IssueLike, col: ColumnId): string {
  const f = issue.fields
  const list = (v: any) => (Array.isArray(v) ? v.map((x) => x?.name ?? String(x)).join(', ') : '')
  switch (col) {
    case 'key': return issue.key
    case 'summary': return f.summary ?? ''
    case 'type': return f.issuetype?.name ?? ''
    case 'status': return f.status?.name ?? ''
    case 'priority': return f.priority?.name ?? ''
    case 'assignee': return f.assignee?.displayName ?? 'Unassigned'
    case 'reporter': return f.reporter?.displayName ?? ''
    case 'project': return f.project?.key ?? ''
    case 'labels': return list(f.labels)
    case 'components': return list(f.components)
    case 'fixVersions': return list(f.fixVersions)
    case 'sprint': return f.sprint?.name ?? ''
    case 'storyPoints': return f.storyPoints == null ? '' : String(f.storyPoints)
    case 'created': case 'updated': case 'resolved': return f[col] ? String(f[col]).slice(0, 10) : ''
    case 'resolution': return f.resolution?.name ?? ''
    case 'duedate': case 'startdate': return f[col] ?? ''
  }
}

/** Resolves group issue ids to issues, in group order; ids that are not on the page are skipped. */
export function issuesOf<T extends { id: number }>(ids: number[], byId: Map<number, T>): T[] {
  const out: T[] = []
  for (const id of ids) { const i = byId.get(id); if (i) out.push(i) }
  return out
}

export interface TimelineItem { key: string; summary: string; start: string; end: string | null }

/** Issues with a start or due date become timeline bars (start = start date, else due date); the rest are unscheduled. */
export function timelineItems(issues: IssueLike[]): { items: TimelineItem[]; unscheduled: IssueLike[] } {
  const items: TimelineItem[] = []
  const unscheduled: IssueLike[] = []
  for (const i of issues) {
    const start: string | null = i.fields.startdate ?? i.fields.duedate ?? null
    const end: string | null = i.fields.duedate ?? null
    if (!start) { unscheduled.push(i); continue }
    items.push({ key: i.key, summary: i.fields.summary ?? '', start, end: end && end >= start ? end : null })
  }
  return { items, unscheduled }
}

export const VIEW_EXPORT_FORMATS = ['csv', 'xlsx', 'json'] as const
