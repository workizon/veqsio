/**
 * Pure helpers for sprint planning (moving issues between sprints and the backlog, starting and
 * completing sprints). No database access so the rules are unit-testable.
 */

export type SprintState = 'future' | 'active' | 'closed'
export type StatusCategory = 'todo' | 'in_progress' | 'done' | 'cancelled'

/** Normalises a list of issue keys: trim, upper-case, drop blanks and duplicates (order kept). */
export function normalizeIssueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keys) {
    const k = String(raw ?? '').trim().toUpperCase()
    if (k && !seen.has(k)) { seen.add(k); out.push(k) }
  }
  return out
}

/** Sum of story points; issues without an estimate count as 0. */
export function sumPoints(rows: ReadonlyArray<{ points?: number | null }>): number {
  let total = 0
  for (const r of rows) total += typeof r.points === 'number' && Number.isFinite(r.points) ? r.points : 0
  return Math.round(total * 100) / 100
}

export interface MoveInput {
  issueId: number
  /** Sprints (future/active) the issue currently belongs to. */
  openSprintIds: number[]
}

export interface MovePlan {
  /** Issues that need a new membership row in the target. */
  add: number[]
  /** Memberships to delete (issue left another open sprint, or the backlog move). */
  remove: Array<{ issueId: number; sprintId: number }>
  /** Issues already where they should be. */
  unchanged: number[]
}

/** Plan moving issues into `targetSprintId`, or to the backlog when it is null. */
export function planMove(issues: readonly MoveInput[], targetSprintId: number | null): MovePlan {
  const plan: MovePlan = { add: [], remove: [], unchanged: [] }
  for (const i of issues) {
    const others = i.openSprintIds.filter((s) => s !== targetSprintId)
    for (const sprintId of others) plan.remove.push({ issueId: i.issueId, sprintId })
    if (targetSprintId === null) {
      if (others.length === 0) plan.unchanged.push(i.issueId)
    } else if (i.openSprintIds.includes(targetSprintId)) {
      if (others.length === 0) plan.unchanged.push(i.issueId)
    } else {
      plan.add.push(i.issueId)
    }
  }
  return plan
}

/**
 * New order of a sprint after inserting `moving` before/after an anchor issue. Without a valid
 * anchor the moved issues go to the end. Moved issues keep their relative order.
 */
export function insertRank(order: readonly number[], moving: readonly number[], before?: number | null, after?: number | null): number[] {
  const movingSet = new Set(moving)
  const rest = order.filter((id) => !movingSet.has(id))
  const movedInOrder = [...order.filter((id) => movingSet.has(id)), ...moving.filter((id) => !order.includes(id))]
  let at = rest.length
  if (before != null && rest.includes(before)) at = rest.indexOf(before)
  else if (after != null && rest.includes(after)) at = rest.indexOf(after) + 1
  return [...rest.slice(0, at), ...movedInOrder, ...rest.slice(at)]
}

export interface CompletionIssue { id: number; category: StatusCategory; points?: number | null }
export interface CompletionSplit {
  completed: CompletionIssue[]
  incomplete: CompletionIssue[]
  cancelled: CompletionIssue[]
  completedPoints: number
  incompletePoints: number
}

/** Issues whose status category is done stay in the closed sprint, the rest are moved. */
export function splitForCompletion(issues: readonly CompletionIssue[]): CompletionSplit {
  // Cancelled issues are closed: they stay in the sprint but count neither as completed nor as incomplete work.
  const cancelled = issues.filter((i) => i.category === 'cancelled')
  const completed = issues.filter((i) => i.category === 'done')
  const incomplete = issues.filter((i) => i.category !== 'done' && i.category !== 'cancelled')
  return { completed, incomplete, cancelled, completedPoints: sumPoints(completed), incompletePoints: sumPoints(incomplete) }
}

/** `"backlog"`, a sprint id (number or numeric string) or null when the value is invalid. */
export function parseMoveTarget(v: unknown): 'backlog' | number | null {
  if (v === 'backlog') return 'backlog'
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

export interface StartCheck {
  state: string | null
  name: string | null | undefined
  startDate: Date | null | undefined
  endDate: Date | null | undefined
}

/** Reasons a sprint cannot be started (empty when it can). */
export function validateSprintStart(s: StartCheck): string[] {
  const errors: string[] = []
  if (s.state !== 'future') errors.push('Only future sprints can be started')
  if (!s.name || !s.name.trim()) errors.push('Sprint name is required')
  if (!s.startDate || Number.isNaN(s.startDate.getTime())) errors.push('Start date is required')
  if (!s.endDate || Number.isNaN(s.endDate.getTime())) errors.push('End date is required')
  if (s.startDate && s.endDate && s.endDate.getTime() <= s.startDate.getTime()) errors.push('End date must be after the start date')
  return errors
}

/** Parallel active sprints are allowed unless the board config sets `allowParallelSprints: false`. */
export function parallelSprintsAllowed(config: unknown): boolean {
  return !(config && typeof config === 'object' && (config as Record<string, unknown>).allowParallelSprints === false)
}

/** Story points from a custom field value (numeric string or number). */
export function toPoints(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Names accepted as the story points custom field (lower-case). */
export const STORY_POINT_FIELD_NAMES = ['story points', 'story point estimate', 'story point', 'storypoints']
