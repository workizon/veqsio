/**
 * Pure helpers for bulk issue operations (no database access): request validation, label/version list merging,
 * grouping of undo information and the intersection of available transitions.
 * The executor lives in routes/bulk.ts and replays the normal single-issue endpoints for every issue.
 */
import { z } from 'zod'

export const MAX_BULK_ISSUES = 500

export const BULK_OPERATIONS = [
  'transition', 'edit', 'move', 'delete', 'watch', 'unwatch', 'label', 'assign', 'priority', 'sprint', 'fixVersion', 'component',
] as const
export type BulkOperation = (typeof BULK_OPERATIONS)[number]

/** Operations whose old values are returned so the client can offer "Undo". Delete and transition are not undoable. */
export const UNDOABLE: ReadonlySet<BulkOperation> = new Set(['edit', 'assign', 'priority', 'label', 'fixVersion', 'component'])

const id = z.number().int().positive()
const idList = z.array(id).max(200)
const listChange = z.object({ add: idList.optional(), remove: idList.optional(), set: idList.optional() }).strict()
  .refine((v) => v.add !== undefined || v.remove !== undefined || v.set !== undefined, 'Provide add, remove or set')
const labelName = z.string().trim().min(1).max(255).refine((s) => !/\s/.test(s), 'Labels cannot contain spaces')
const labelChange = z.object({ add: z.array(labelName).max(100).optional(), remove: z.array(labelName).max(100).optional(), set: z.array(labelName).max(100).optional() }).strict()
  .refine((v) => v.add !== undefined || v.remove !== undefined || v.set !== undefined, 'Provide add, remove or set')

/** Fields the bulk `edit` operation may set. Each uses the single-issue PUT shape. */
export const EDITABLE_FIELDS = ['priority', 'assignee', 'labels', 'components', 'fixVersions', 'versions', 'duedate', 'startdate', 'storyPoints', 'environment'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

const editFields = z.object({
  priority: z.object({ id }).strict().optional(),
  assignee: z.object({ id }).strict().nullable().optional(),
  labels: z.array(labelName).max(100).optional(),
  components: z.array(z.object({ id }).strict()).max(200).optional(),
  fixVersions: z.array(z.object({ id }).strict()).max(200).optional(),
  versions: z.array(z.object({ id }).strict()).max(200).optional(),
  duedate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  startdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  storyPoints: z.number().finite().min(0).nullable().optional(),
  environment: z.string().max(10_000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Provide at least one field')

const none = z.object({}).strict()

const SCHEMAS = {
  transition: z.object({
    transitionId: z.coerce.number().int().positive(),
    fields: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().max(100_000).optional(),
  }).strict(),
  edit: z.object({ fields: editFields }).strict(),
  move: z.object({ projectId: id, issueTypeId: id.optional() }).strict(),
  delete: none,
  watch: none,
  unwatch: none,
  label: labelChange,
  assign: z.object({ assigneeId: id.nullable() }).strict(),
  priority: z.object({ priorityId: id }).strict(),
  sprint: z.object({ sprintId: id.nullable() }).strict(),
  fixVersion: listChange,
  component: listChange,
} as const

export type BulkParams = Record<string, any>

export function parseBulkParams(operation: BulkOperation, params: unknown): { ok: true; params: BulkParams } | { ok: false; error: string } {
  const r = SCHEMAS[operation].safeParse(params ?? {})
  if (r.success) return { ok: true, params: r.data as BulkParams }
  return { ok: false, error: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ') }
}

/** Validates the list of issue keys: required, strings, de-duplicated (order kept) and at most MAX_BULK_ISSUES. */
export function normalizeIssueKeys(raw: unknown): { ok: true; keys: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'issueKeys must be a non-empty array' }
  if (raw.length > MAX_BULK_ISSUES) return { ok: false, error: `At most ${MAX_BULK_ISSUES} issues per request` }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const k of raw) {
    if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(k.trim())) return { ok: false, error: `Invalid issue key: ${String(k).slice(0, 50)}` }
    const key = k.trim().toUpperCase()
    if (!seen.has(key)) { seen.add(key); keys.push(key) }
  }
  return { ok: true, keys }
}

/** Applies a set/add/remove change to a list (labels, version ids, component ids). `set` wins, add keeps order and uniqueness. */
export function applyListChange<T extends string | number>(current: T[], change: { add?: T[]; remove?: T[]; set?: T[] }): T[] {
  if (change.set) return [...new Set(change.set)]
  const removed = new Set(change.remove ?? [])
  const out = current.filter((v) => !removed.has(v))
  for (const a of change.add ?? []) if (!out.includes(a)) out.push(a)
  return out
}

export const sameList = <T>(a: T[], b: T[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

export interface UndoGroup { operation: BulkOperation; issueKeys: string[]; params: BulkParams }

/** Groups per-issue undo entries with identical params so one bulk call restores many issues. */
export function groupUndo(operation: BulkOperation, entries: Array<{ key: string; params: BulkParams }>): UndoGroup[] {
  const groups = new Map<string, UndoGroup>()
  for (const e of entries) {
    const sig = JSON.stringify(e.params, Object.keys(e.params).sort())
    const g = groups.get(sig)
    if (g) g.issueKeys.push(e.key)
    else groups.set(sig, { operation, issueKeys: [e.key], params: e.params })
  }
  return [...groups.values()]
}

export interface TransitionOption { id: number; name: string; to: { id: number; name: string }; count: number; issueKeys: string[]; requiresComment?: boolean; requiresResolution?: boolean }

/** Merges the available transitions of every issue into options with the number of issues each one applies to. */
export function mergeTransitions(perIssue: Array<{ key: string; transitions: Array<{ id: number; name: string; to: { id: number; name: string }; requiresComment?: boolean; requiresResolution?: boolean }> }>): { total: number; transitions: TransitionOption[]; commonIds: number[] } {
  const byId = new Map<number, TransitionOption>()
  for (const { key, transitions } of perIssue) {
    for (const t of transitions) {
      const o = byId.get(t.id) ?? { id: t.id, name: t.name, to: { id: t.to.id, name: t.to.name }, count: 0, issueKeys: [], requiresComment: t.requiresComment, requiresResolution: t.requiresResolution }
      o.count++; o.issueKeys.push(key); byId.set(t.id, o)
    }
  }
  const total = perIssue.length
  const transitions = [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { total, transitions, commonIds: transitions.filter((t) => t.count === total).map((t) => t.id) }
}

export interface BulkFailure { key: string; reason: string }
export interface BulkResult { succeeded: string[]; failed: BulkFailure[] }

/** Collapses failures with the same reason, e.g. "Transition not available" x 12, for the preview. */
export function groupFailures(failed: BulkFailure[]): Array<{ reason: string; count: number; keys: string[] }> {
  const m = new Map<string, string[]>()
  for (const f of failed) m.set(f.reason, [...(m.get(f.reason) ?? []), f.key])
  return [...m.entries()].map(([reason, keys]) => ({ reason, count: keys.length, keys })).sort((a, b) => b.count - a.count)
}

/** Best human readable reason from an error response body of the single-issue endpoints. */
export function reasonFromBody(status: number, body: any): string {
  const msgs: string[] = []
  if (Array.isArray(body?.errorMessages)) msgs.push(...body.errorMessages.filter((m: unknown) => typeof m === 'string'))
  if (body?.errors && typeof body.errors === 'object') msgs.push(...Object.values(body.errors).filter((m): m is string => typeof m === 'string'))
  if (Array.isArray(body?.validationErrors)) msgs.push(...body.validationErrors.map((e: any) => (typeof e === 'string' ? e : e?.message)).filter(Boolean))
  const text = [...new Set(msgs)].join('; ')
  if (text) return text.slice(0, 500)
  if (status === 403) return 'Forbidden'
  if (status === 404) return 'Issue does not exist or you do not have permission to see it.'
  return `Request failed (${status})`
}
