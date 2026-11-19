/** Pure decisions behind the undo toasts, kept out of the components so they can be tested. */

export interface TransitionLike {
  id: number
  name: string
  to: { id?: number; name: string; statusCategory?: { key?: string; normalizedKey?: string } | string | null }
  hasScreen?: boolean
  requiresResolution?: boolean
  requiresComment?: boolean
  requiresInput?: boolean
}

function categoryOf(t: TransitionLike['to']): string {
  const c = t.statusCategory
  const raw = typeof c === 'string' ? c : c?.normalizedKey || c?.key || ''
  return raw.toLowerCase().replace(/[\s-]/g, '_')
}

/**
 * After a status transition, an Undo is only offered when it can be done by one plain reverse transition:
 *  - the move did not resolve the issue (resolution, resolved date and flagged labels are not undone by the API),
 *  - and the workflow offers a transition straight back to the previous status that needs no input.
 * Returns that transition, or null when undo is not safe.
 */
export function findReverseTransition(
  available: TransitionLike[],
  previousStatusName: string,
  movedTo: TransitionLike['to'],
): TransitionLike | null {
  if (categoryOf(movedTo) === 'done') return null
  const candidates = available.filter(
    (t) =>
      t.to.name === previousStatusName &&
      !t.hasScreen &&
      !t.requiresInput &&
      !t.requiresResolution &&
      !t.requiresComment,
  )
  return candidates[0] ?? null
}

/** Value that restores an assignee after "unassign" (or after a change): `{ id }` or `null`. */
export function assigneeRestorePatch(previous: { id: number } | null | undefined): { assignee: { id: number } | null } {
  return { assignee: previous ? { id: previous.id } : null }
}

export function labelsRemovalMessage(removed: string): string {
  return `Label "${removed}" removed`
}

export interface BulkIssueSnapshot {
  key: string
  previous: Record<string, unknown>
}

/**
 * Builds per-issue restore bodies for a bulk edit. `field` is the API field name; `readPrevious` extracts the
 * value that reverses it from the issue as it was before the edit.
 */
export function buildBulkSnapshots<T extends { key: string }>(
  issues: T[],
  field: string,
  readPrevious: (issue: T) => unknown,
): BulkIssueSnapshot[] {
  return issues.map((i) => ({ key: i.key, previous: { [field]: readPrevious(i) } }))
}

/** Which snapshots actually change (skips issues that already hold the new value). */
export function changedSnapshots(snaps: BulkIssueSnapshot[], field: string, next: unknown): BulkIssueSnapshot[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  return snaps.filter((s) => !same(s.previous[field], next))
}
