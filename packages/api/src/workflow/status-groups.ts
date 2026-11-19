/**
 * Status groups (the category of a status).
 *
 * Five groups exist: Backlog, Unstarted ("To do"), Started ("In progress"), Completed ("Done") and Cancelled.
 * The stored value (`statuses.category`) keeps the historical spellings 'to_do', 'in_progress' and 'done';
 * 'backlog' and 'cancelled' are new, additive values. Everything that only knows the three classic buckets
 * (Jira-style `statusCategory`, board columns, "is resolved", burndown) goes through `baseCategory`, which folds
 * Backlog into To do and Cancelled into Done, so existing logic keeps working unchanged.
 *
 * Cancelled is done-like for resolution (an issue in a cancelled status is closed and needs a resolution), but it
 * is not completed work: reports, velocity and progress bars leave cancelled issues out of both the done count and
 * the total (`countsTowardProgress`).
 */

export type StatusGroup = 'backlog' | 'to_do' | 'in_progress' | 'done' | 'cancelled';
export type BaseCategory = 'todo' | 'in_progress' | 'done';
/** Category as used by the reports: the classic three plus cancelled (backlog is folded into todo). */
export type ReportCategory = BaseCategory | 'cancelled';

export const STATUS_GROUPS: ReadonlyArray<{ id: StatusGroup; label: string; color: string; description: string }> = [
  { id: 'backlog', label: 'Backlog', color: '#8993A4', description: 'Ideas and work that is not planned yet' },
  { id: 'to_do', label: 'To do', color: '#667085', description: 'Planned, not started (Unstarted)' },
  { id: 'in_progress', label: 'In progress', color: '#2D54D8', description: 'Work has started (Started)' },
  { id: 'done', label: 'Done', color: '#16A06A', description: 'Finished work (Completed)' },
  { id: 'cancelled', label: 'Cancelled', color: '#B42318', description: 'Will not be done; counts as closed but not as completed work' },
];

/** Normalise the many spellings of a category to one of the five groups. Unknown values count as in progress. */
export function groupOf(category: string | null | undefined): StatusGroup {
  const c = (category ?? '').toLowerCase().trim().replace(/[\s-]/g, '_');
  if (c === 'backlog') return 'backlog';
  if (c === 'cancelled' || c === 'canceled') return 'cancelled';
  if (c === 'done' || c === 'complete' || c === 'completed') return 'done';
  if (c === 'todo' || c === 'to_do' || c === 'new' || c === 'unstarted' || c === '') return 'to_do';
  return 'in_progress';
}

/** The classic three buckets: backlog counts as to do, cancelled as done. */
export function baseCategory(category: string | null | undefined): BaseCategory {
  const g = groupOf(category);
  return g === 'done' || g === 'cancelled' ? 'done' : g === 'in_progress' ? 'in_progress' : 'todo';
}

/** Report bucket: like baseCategory, but cancelled stays separate so it can be excluded. */
export function reportCategory(category: string | null | undefined): ReportCategory {
  const g = groupOf(category);
  return g === 'cancelled' ? 'cancelled' : baseCategory(category);
}

export const isCancelled = (category: string | null | undefined): boolean => groupOf(category) === 'cancelled';
/** Closed for resolution purposes: done or cancelled. */
export const isDoneLike = (category: string | null | undefined): boolean => baseCategory(category) === 'done';
/** Cancelled issues are neither completed nor outstanding work. */
export const countsTowardProgress = (category: string | null | undefined): boolean => !isCancelled(category);

/** Stored category values accepted when creating or editing a status. */
export const STATUS_CATEGORY_VALUES = ['backlog', 'to_do', 'in_progress', 'done', 'cancelled'] as const;

export interface ProgressSummary {
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  cancelled: number;
  /** 0..100 over the work that counts (cancelled excluded) */
  percentDone: number;
}

/** Progress over a list of statuses' categories, weighting by `size` (default 1). Cancelled items are reported but excluded from total and percent. */
export function summarizeProgress(items: ReadonlyArray<{ category: string | null | undefined; size?: number }>): ProgressSummary {
  const s: ProgressSummary = { total: 0, done: 0, inProgress: 0, todo: 0, cancelled: 0, percentDone: 0 };
  for (const i of items) {
    const w = i.size ?? 1;
    const c = reportCategory(i.category);
    if (c === 'cancelled') { s.cancelled += w; continue; }
    s.total += w;
    if (c === 'done') s.done += w;
    else if (c === 'in_progress') s.inProgress += w;
    else s.todo += w;
  }
  s.percentDone = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  return s;
}
