import { formatDuration, type SlaResult } from '@/hooks/use-servicedesk'
import { slaProgress, slaTone, type SlaTone } from '@/lib/sla'

/** Tone colours come from the design tokens, so light and dark themes both work. */
const TONE: Record<SlaTone, { color: string; bar: string }> = {
  ok: { color: 'var(--text-secondary)', bar: 'var(--info)' },
  warning: { color: 'var(--warning)', bar: 'var(--warning)' },
  danger: { color: 'var(--error)', bar: 'var(--error)' },
  muted: { color: 'var(--text-tertiary)', bar: 'var(--text-tertiary)' },
  met: { color: 'var(--success)', bar: 'var(--success)' },
}

export function slaLabel(sla: SlaResult): string {
  if (sla.status === 'met') return 'Met'
  if (sla.status === 'paused') return `Paused, ${formatDuration(sla.remainingMs)} left`
  if (sla.breached) return `Overdue by ${formatDuration(-sla.remainingMs)}`
  return `${formatDuration(sla.remainingMs)} left`
}

const when = (iso?: string | null) => {
  if (!iso) return null
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso }
}

/** Plain-text tooltip: metric, goal, calendar and due date. */
export function slaTooltip(sla: SlaResult): string {
  const lines = [sla.name, `Goal: ${formatDuration(sla.targetMs)}`, `Elapsed: ${formatDuration(sla.elapsedMs)}`]
  if (sla.calendar) lines.push(`Calendar: ${sla.calendar}`)
  if (sla.status === 'met') lines.push(`Completed: ${when(sla.stoppedAt) ?? 'yes'}`)
  else if (sla.status === 'paused') lines.push('Clock paused')
  else if (sla.dueAt) lines.push(`${sla.breached ? 'Was due' : 'Due'}: ${when(sla.dueAt)}`)
  return lines.join('\n')
}

/** Compact JSM-style SLA chip: metric name, time left / overdue / paused / met and a thin progress bar. */
export function SlaBadge({ sla }: { sla: SlaResult }) {
  const tone = TONE[slaTone(sla)]
  return (
    <span
      title={slaTooltip(sla)}
      data-sla-status={sla.status}
      className="inline-flex flex-col gap-0.5 rounded-md border border-[var(--surface-3)] bg-[var(--surface-2)] px-2 py-1 text-xs min-w-[9rem] max-w-[16rem]"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[var(--text-tertiary)]">{sla.name}</span>
        <span className="font-medium whitespace-nowrap" style={{ color: tone.color }}>{slaLabel(sla)}</span>
      </span>
      <span
        role="progressbar" aria-label={`${sla.name} progress`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(slaProgress(sla))}
        className="block h-[3px] w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
      >
        <span className="block h-full rounded-full" style={{ width: `${slaProgress(sla)}%`, background: tone.bar }} />
      </span>
    </span>
  )
}
