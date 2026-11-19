/**
 * Time in status, computed from the issue history (`status` rows hold status names, old and new).
 * Pure functions: the routes load rows and pass them in, so everything here is unit-testable.
 */

export interface StatusChange {
  at: Date;
  from: string | null;
  to: string | null;
  by: number | null;
}

export interface StatusSegment {
  status: string;
  category: string;
  enteredAt: Date;
  /** null while the issue is still in this status */
  leftAt: Date | null;
  durationMs: number;
  /** user who moved the issue into this status (the reporter for the initial status); null for system actors */
  movedBy: number | null;
}

export interface TimeInStatus {
  segments: StatusSegment[];
  byStatus: Array<{ status: string; category: string; durationMs: number; visits: number }>;
  byCategory: Array<{ category: string; durationMs: number }>;
  totalMs: number;
}

export type CategoryLookup = (statusName: string) => string;

export function computeTimeInStatus(input: {
  createdAt: Date;
  creatorId: number | null;
  currentStatus: string;
  /** status history rows, any order */
  changes: StatusChange[];
  now?: Date;
  categoryOf?: CategoryLookup;
}): TimeInStatus {
  const now = input.now ?? new Date();
  const categoryOf = input.categoryOf ?? (() => 'to_do');
  const changes = input.changes.filter((c) => c.to).sort((a, b) => a.at.getTime() - b.at.getTime());
  const segments: StatusSegment[] = [];

  let status = changes[0]?.from ?? input.currentStatus;
  let enteredAt = input.createdAt;
  let movedBy = input.creatorId;
  const close = (leftAt: Date | null) => {
    const end = (leftAt ?? now).getTime();
    segments.push({
      status, category: categoryOf(status), enteredAt, leftAt, movedBy,
      durationMs: Math.max(0, end - enteredAt.getTime()),
    });
  };
  for (const ch of changes) {
    close(ch.at);
    status = ch.to!;
    enteredAt = ch.at;
    movedBy = ch.by;
  }
  close(null);

  const byStatusMap = new Map<string, { status: string; category: string; durationMs: number; visits: number }>();
  const byCategoryMap = new Map<string, number>();
  for (const s of segments) {
    const e = byStatusMap.get(s.status) ?? { status: s.status, category: s.category, durationMs: 0, visits: 0 };
    e.durationMs += s.durationMs;
    e.visits += 1;
    byStatusMap.set(s.status, e);
    byCategoryMap.set(s.category, (byCategoryMap.get(s.category) ?? 0) + s.durationMs);
  }
  return {
    segments,
    byStatus: [...byStatusMap.values()],
    byCategory: [...byCategoryMap].map(([category, durationMs]) => ({ category, durationMs })),
    totalMs: segments.reduce((n, s) => n + s.durationMs, 0),
  };
}

export interface AverageRow {
  status: string;
  category: string;
  /** distinct issues that spent time in the status */
  issues: number;
  visits: number;
  totalMs: number;
  /** average duration of one stay (totalMs / visits) */
  avgMs: number;
}

/** Average time per stay in each status over many issues. Sorted by average, longest first. */
export function averageTimeInStatus(perIssue: TimeInStatus[]): AverageRow[] {
  const acc = new Map<string, AverageRow>();
  for (const t of perIssue) {
    for (const s of t.byStatus) {
      const e = acc.get(s.status) ?? { status: s.status, category: s.category, issues: 0, visits: 0, totalMs: 0, avgMs: 0 };
      e.issues += 1;
      e.visits += s.visits;
      e.totalMs += s.durationMs;
      acc.set(s.status, e);
    }
  }
  return [...acc.values()]
    .map((e) => ({ ...e, avgMs: e.visits ? Math.round(e.totalMs / e.visits) : 0 }))
    .sort((a, b) => b.avgMs - a.avgMs || a.status.localeCompare(b.status));
}

/** "2d 3h", "45m", "<1m" */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}
