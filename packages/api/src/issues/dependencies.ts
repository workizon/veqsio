/**
 * Pure helpers for dependency (scheduling) links between issues.
 *
 * A dependency link has a predecessor (the issue on the "outward" side: it "starts before" / "finishes before")
 * and a successor (the issue on the "inward" side). In `issue_links` the predecessor is `linked_issue_id` and
 * the successor is `issue_id`, matching how the UI shows "X starts after Y" on X.
 */

export type Scheduling = 'starts_before' | 'finishes_before';

export interface DependencyEdge { predecessor: number; successor: number }
export interface IssueDates { start: number | null; end: number | null }

/** True when adding predecessor -> successor to `edges` would close a cycle (self links are cycles too). */
export function wouldCreateCycle(edges: readonly DependencyEdge[], predecessor: number, successor: number): boolean {
  if (predecessor === successor) return true;
  const next = new Map<number, number[]>();
  for (const e of edges) {
    const l = next.get(e.predecessor);
    if (l) l.push(e.successor); else next.set(e.predecessor, [e.successor]);
  }
  // A cycle exists when the new predecessor is reachable from the new successor.
  const seen = new Set<number>([successor]);
  const stack = [successor];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === predecessor) return true;
    for (const n of next.get(cur) ?? []) {
      if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return false;
}

export interface DependencyConflict { conflict: boolean; message: string | null }

/**
 * Whether the dates of two issues violate a dependency.
 * - finishes_before: the predecessor must end on or before the day the successor starts.
 * - starts_before: the predecessor must start on or before the day the successor starts.
 * Missing dates never produce a conflict (nothing to compare).
 */
export function dependencyConflict(kind: Scheduling, pred: IssueDates, succ: IssueDates): DependencyConflict {
  const day = (t: number) => Math.floor(t / 86_400_000);
  if (kind === 'finishes_before') {
    if (pred.end !== null && succ.start !== null && day(pred.end) > day(succ.start)) {
      return { conflict: true, message: 'The predecessor ends after the successor starts' };
    }
  } else if (pred.start !== null && succ.start !== null && day(pred.start) > day(succ.start)) {
    return { conflict: true, message: 'The predecessor starts after the successor starts' };
  }
  return { conflict: false, message: null };
}

export function isScheduling(v: unknown): v is Scheduling {
  return v === 'starts_before' || v === 'finishes_before';
}
