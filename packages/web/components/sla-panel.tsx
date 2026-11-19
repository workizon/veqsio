import { formatDuration, type SlaResult } from '@/hooks/use-servicedesk'
import { slaLabel } from '@/components/sla-badge'
import { slaProgress, slaTone } from '@/lib/sla'

const COLOR = { ok: 'var(--info)', warning: 'var(--warning)', danger: 'var(--error)', muted: 'var(--text-tertiary)', met: 'var(--success)' } as const

const when = (iso?: string | null) => {
  if (!iso) return null
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso }
}

/**
 * Jira Service Management style SLA panel for the issue view (agents only; the data comes from the
 * staff-only request meta endpoint, never from the customer portal).
 * Usage: <SlaPanel sla={requestMeta.data.sla} />
 */
export function SlaPanel({ sla }: { sla?: SlaResult[] }) {
  if (!sla || sla.length === 0) return null
  return (
    <section aria-label="SLAs" className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">SLAs</h3>
      <ul className="space-y-3">
        {sla.map((s) => {
          const color = COLOR[slaTone(s)]
          return (
            <li key={s.slaId} className="space-y-1" data-sla-status={s.status}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{s.name}</span>
                <span className="font-medium whitespace-nowrap" style={{ color }}>{slaLabel(s)}</span>
              </div>
              <div
                role="progressbar" aria-label={`${s.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(slaProgress(s))}
                className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
              >
                <div className="h-full rounded-full" style={{ width: `${slaProgress(s)}%`, background: color }} />
              </div>
              <div className="text-xs text-[var(--text-tertiary)] flex flex-wrap gap-x-3">
                <span>Goal {formatDuration(s.targetMs)}</span>
                {s.calendar && <span>{s.calendar}</span>}
                {s.status === 'met' ? (when(s.stoppedAt) && <span>Completed {when(s.stoppedAt)}</span>)
                  : s.status === 'paused' ? <span>Clock paused</span>
                  : s.dueAt && <span>{s.breached ? 'Was due' : 'Due'} {when(s.dueAt)}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
