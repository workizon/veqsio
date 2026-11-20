'use client'

import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { formatDuration, type SlaResult } from '@/hooks/use-servicedesk'
import { slaLabel } from '@/components/sla-badge'
import { slaProgress, slaTone } from '@/lib/sla'

const COLOR = { ok: 'var(--info)', warning: 'var(--warning)', danger: 'var(--error)', muted: 'var(--text-tertiary)', met: 'var(--success)' } as const

const when = (iso?: string | null) => {
  if (!iso) return null
  try { return new Date(iso).toLocaleString(getIntlLocale(), { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso }
}

/**
 * Jira Service Management style SLA panel for the issue view (agents only; the data comes from the
 * staff-only request meta endpoint, never from the customer portal).
 * Usage: <SlaPanel sla={requestMeta.data.sla} />
 */
export function SlaPanel({ sla }: { sla?: SlaResult[] }) {
  const { tr } = useI18n()
  if (!sla || sla.length === 0) return null
  return (
    <section aria-label={tr('SLAs')} className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{tr('SLAs')}</h3>
      <ul className="space-y-3">
        {sla.map((s) => {
          const color = COLOR[slaTone(s)]
          return (
            <li key={s.slaId} className="space-y-1" data-sla-status={s.status}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{s.name}</span>
                <span className="font-medium whitespace-nowrap" style={{ color }}>{slaLabel(s, tr)}</span>
              </div>
              <div
                role="progressbar" aria-label={tr('{name} progress', { name: s.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(slaProgress(s))}
                className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
              >
                <div className="h-full rounded-full" style={{ width: `${slaProgress(s)}%`, background: color }} />
              </div>
              <div className="text-xs text-[var(--text-tertiary)] flex flex-wrap gap-x-3">
                <span>{tr('Goal {d}', { d: formatDuration(s.targetMs) })}</span>
                {s.calendar && <span>{s.calendar}</span>}
                {s.status === 'met' ? (when(s.stoppedAt) && <span>{tr('Completed {when}', { when: when(s.stoppedAt) ?? '' })}</span>)
                  : s.status === 'paused' ? <span>{tr('Clock paused')}</span>
                  : s.dueAt && <span>{s.breached ? tr('Was due') : tr('Due')} {when(s.dueAt)}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
