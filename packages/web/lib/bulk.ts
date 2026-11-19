/**
 * Pure logic of the "Bulk change" dialog: operations, parameter building, result summaries, retry and undo.
 * No React or DOM here (unit tested in tests/bulk.test.ts); the dialog is components/bulk-change-dialog.tsx.
 */

export type BulkOperation =
  | 'transition' | 'edit' | 'move' | 'delete' | 'watch' | 'unwatch' | 'label' | 'assign' | 'priority' | 'sprint' | 'fixVersion' | 'component'

export const MAX_BULK = 500

export interface BulkFailure { key: string; reason: string }
export interface UndoGroup { operation: BulkOperation; issueKeys: string[]; params: Record<string, unknown> }
export interface BulkResult {
  operation: BulkOperation
  total: number
  succeeded: string[]
  failed: BulkFailure[]
  preview?: boolean
  failureGroups?: Array<{ reason: string; count: number; keys: string[] }>
  undo?: UndoGroup[]
}

export interface OperationDef {
  id: BulkOperation
  label: string
  description: string
  /** Old values come back from the server and can be restored with "Undo". */
  undoable: boolean
  destructive?: boolean
  /** Needs every selected issue to be in the same project (versions, components and sprints belong to one project). */
  singleProject?: boolean
  /** Past tense for the result line, e.g. "updated". */
  done: string
}

export const OPERATIONS: OperationDef[] = [
  { id: 'edit', label: 'Edit fields', description: 'Set the due date or story points', undoable: true, done: 'updated' },
  { id: 'assign', label: 'Assign', description: 'Assign or unassign', undoable: true, done: 'assigned' },
  { id: 'priority', label: 'Change priority', description: 'Set one priority', undoable: true, done: 'updated' },
  { id: 'label', label: 'Labels', description: 'Add, remove or replace labels', undoable: true, done: 'updated' },
  { id: 'transition', label: 'Transition', description: 'Move through the workflow', undoable: false, done: 'transitioned' },
  { id: 'fixVersion', label: 'Fix versions', description: 'Add, remove or replace fix versions', undoable: true, singleProject: true, done: 'updated' },
  { id: 'component', label: 'Components', description: 'Add, remove or replace components', undoable: true, singleProject: true, done: 'updated' },
  { id: 'sprint', label: 'Sprint', description: 'Move to a sprint or back to the backlog', undoable: false, singleProject: true, done: 'moved' },
  { id: 'move', label: 'Move to project', description: 'Move to another project', undoable: false, done: 'moved' },
  { id: 'watch', label: 'Watch', description: 'Start watching', undoable: false, done: 'watched' },
  { id: 'unwatch', label: 'Stop watching', description: 'Stop watching', undoable: false, done: 'unwatched' },
  { id: 'delete', label: 'Delete', description: 'Delete permanently', undoable: false, destructive: true, done: 'deleted' },
]

export const operationDef = (id: BulkOperation): OperationDef => OPERATIONS.find((o) => o.id === id)!

export type ListMode = 'add' | 'remove' | 'set'

/** Everything the parameter step collects; only the fields of the chosen operation are read. */
export interface BulkForm {
  transitionId: number | null
  comment: string
  resolutionId: number | null
  /** `null` = unassign, `undefined` = nothing chosen yet. */
  assigneeId: number | null | undefined
  priorityId: number | null
  labelMode: ListMode
  labels: string[]
  listMode: ListMode
  ids: number[]
  projectId: number | null
  /** `null` = back to the backlog, `undefined` = nothing chosen yet. */
  sprintId: number | null | undefined
  dueDate: string
  clearDueDate: boolean
  storyPoints: string
  clearStoryPoints: boolean
  confirmDelete: boolean
}

export const emptyForm = (): BulkForm => ({
  transitionId: null, comment: '', resolutionId: null, assigneeId: undefined, priorityId: null, labelMode: 'add', labels: [],
  listMode: 'add', ids: [], projectId: null, sprintId: undefined, dueDate: '', clearDueDate: false, storyPoints: '', clearStoryPoints: false,
  confirmDelete: false,
})

/** Splits "a, b  c" into unique label names (labels cannot contain spaces). */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The API `params` for an operation, or null while the form is incomplete. */
export function buildParams(op: BulkOperation, f: BulkForm): Record<string, unknown> | null {
  switch (op) {
    case 'transition': {
      if (!f.transitionId) return null
      const fields = f.resolutionId ? { resolution: { id: f.resolutionId } } : undefined
      return { transitionId: f.transitionId, ...(fields ? { fields } : {}), ...(f.comment.trim() ? { comment: f.comment.trim() } : {}) }
    }
    case 'assign': return f.assigneeId === undefined ? null : { assigneeId: f.assigneeId }
    case 'priority': return f.priorityId ? { priorityId: f.priorityId } : null
    case 'label': return f.labels.length === 0 && f.labelMode !== 'set' ? null : { [f.labelMode]: f.labels }
    case 'fixVersion':
    case 'component': return f.ids.length === 0 && f.listMode !== 'set' ? null : { [f.listMode]: f.ids }
    case 'move': return f.projectId ? { projectId: f.projectId } : null
    case 'sprint': return f.sprintId === undefined ? null : { sprintId: f.sprintId }
    case 'edit': {
      const fields: Record<string, unknown> = {}
      if (f.clearDueDate) fields.duedate = null
      else if (DATE.test(f.dueDate)) fields.duedate = f.dueDate
      if (f.clearStoryPoints) fields.storyPoints = null
      else if (f.storyPoints.trim() !== '' && Number.isFinite(Number(f.storyPoints)) && Number(f.storyPoints) >= 0) fields.storyPoints = Number(f.storyPoints)
      return Object.keys(fields).length ? { fields } : null
    }
    case 'delete': return f.confirmDelete ? {} : null
    case 'watch':
    case 'unwatch': return {}
  }
}

export interface ResultSummary {
  tone: 'success' | 'warning' | 'error'
  /** One sentence for the live region and the toast. */
  headline: string
  succeeded: number
  failed: number
  failedKeys: string[]
  groups: Array<{ reason: string; count: number; keys: string[] }>
  canRetry: boolean
  canUndo: boolean
}

const plural = (n: number, word = 'issue') => `${n} ${word}${n === 1 ? '' : 's'}`

export function groupFailures(failed: BulkFailure[]): ResultSummary['groups'] {
  const m = new Map<string, string[]>()
  for (const f of failed) m.set(f.reason, [...(m.get(f.reason) ?? []), f.key])
  return [...m.entries()].map(([reason, keys]) => ({ reason, count: keys.length, keys })).sort((a, b) => b.count - a.count)
}

/** Text and flags for the review step (preview) and for the final result. */
export function summarizeResult(r: BulkResult): ResultSummary {
  const ok = r.succeeded.length
  const bad = r.failed.length
  const total = ok + bad
  const def = operationDef(r.operation)
  let tone: ResultSummary['tone'] = bad === 0 ? 'success' : ok === 0 ? 'error' : 'warning'
  let headline: string
  if (r.preview) {
    if (bad === 0) headline = `All ${plural(total)} can be changed.`
    else if (ok === 0) headline = `None of the ${plural(total)} can be changed.`
    else headline = `${ok} of ${plural(total)} can be changed; ${bad} would fail.`
  } else if (bad === 0) headline = `${plural(ok)} ${def.done}.`
  else if (ok === 0) headline = `No issues were ${def.done}; ${bad} failed.`
  else headline = `${ok} of ${plural(total)} ${def.done}; ${bad} failed.`
  if (total === 0) { headline = 'Nothing to do.'; tone = 'warning' }
  return {
    tone, headline, succeeded: ok, failed: bad, failedKeys: r.failed.map((f) => f.key),
    groups: r.failureGroups?.length ? r.failureGroups : groupFailures(r.failed),
    canRetry: !r.preview && bad > 0,
    canUndo: !r.preview && def.undoable && ok > 0 && (r.undo?.length ?? 0) > 0,
  }
}

/** After "Retry failed": issues that now succeeded join the earlier successes, the remaining failures replace the old ones. */
export function mergeRetry(previous: BulkResult, retry: BulkResult): BulkResult {
  const retried = new Set([...retry.succeeded, ...retry.failed.map((f) => f.key)])
  return {
    ...previous,
    succeeded: [...previous.succeeded, ...retry.succeeded],
    failed: [...previous.failed.filter((f) => !retried.has(f.key)), ...retry.failed],
    undo: [...(previous.undo ?? []), ...(retry.undo ?? [])],
  }
}

/** Undo groups restricted to the issues that really changed (a retried group may only partially apply). */
export const undoGroups = (r: BulkResult): UndoGroup[] => (r.undo ?? []).map((g) => ({ ...g, issueKeys: g.issueKeys.filter((k) => r.succeeded.includes(k)) })).filter((g) => g.issueKeys.length > 0)

/** The undo calls summarised: total restored and failed over all groups. */
export function mergeUndoResults(results: BulkResult[]): { restored: number; failed: number } {
  return { restored: results.reduce((n, r) => n + r.succeeded.length, 0), failed: results.reduce((n, r) => n + r.failed.length, 0) }
}

/** Number of distinct projects of the selected issue keys ("TEST-12" -> "TEST"). */
export const projectsOf = (keys: string[]): string[] => [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf('-'))))]
