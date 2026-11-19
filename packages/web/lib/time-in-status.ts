/** Presentation helpers for the time-in-status views (pure, unit-tested). */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m'
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`
  return `${mm}m`
}

/** CSS colour (variable) for a status category / group. */
export function categoryColor(category: string): string {
  switch (category) {
    case 'done': return 'var(--success)'
    case 'in_progress': return 'var(--brand-500)'
    case 'cancelled': return 'var(--error)'
    case 'backlog': return 'var(--surface-4)'
    default: return 'var(--text-tertiary)'
  }
}

export function categoryLabel(category: string): string {
  switch (category) {
    case 'todo': case 'to_do': return 'To do'
    case 'in_progress': return 'In progress'
    case 'done': return 'Done'
    case 'cancelled': return 'Cancelled'
    case 'backlog': return 'Backlog'
    default: return category
  }
}

/** Bar segments with a share of the total (0..100); tiny segments keep a visible minimum so they can be hovered. */
export function barShares<T extends { durationMs: number }>(items: T[], min = 1.5): Array<T & { pct: number }> {
  const total = items.reduce((n, i) => n + i.durationMs, 0)
  if (total <= 0) return items.map((i) => ({ ...i, pct: items.length ? 100 / items.length : 0 }))
  const raw = items.map((i) => Math.max(min, (i.durationMs / total) * 100))
  const sum = raw.reduce((n, v) => n + v, 0)
  return items.map((i, idx) => ({ ...i, pct: (raw[idx] / sum) * 100 }))
}
