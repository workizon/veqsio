'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { CheckCircle2, Info, XCircle } from 'lucide-react'

export interface ExplainReason { kind: string; granted: boolean; decisive: boolean; text: string; link?: string }

/** Shared result card of the admin helpers: a big verdict lozenge and the ordered reasons as a checklist. */
export function ExplainResult({ verdict, positive, title, subtitle, reasons }: { verdict: string; positive: boolean; title: string; subtitle?: string; reasons: ExplainReason[] }) {
  const { tr } = useI18n();

  return (
    <section aria-live="polite" aria-label={tr('Result')} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="verdict"
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-heading-3 font-semibold border ${positive ? 'text-[var(--success)] border-[var(--success)]' : 'text-[var(--error)] border-[var(--error)]'}`}
          style={{ background: `color-mix(in srgb, ${positive ? 'var(--success)' : 'var(--error)'} 12%, transparent)` }}
        >
          {positive ? <CheckCircle2 className="w-5 h-5" aria-hidden /> : <XCircle className="w-5 h-5" aria-hidden />}
          {verdict}
        </span>
        <div className="min-w-0">
          <p className="text-body font-medium text-[var(--text-primary)]">{title}</p>
          {subtitle && <p className="text-caption text-[var(--text-tertiary)]">{subtitle}</p>}
        </div>
      </div>
      <div>
        <h2 className="text-heading-3 text-[var(--text-primary)] mb-2">{tr('Why')}</h2>
        <ol className="space-y-2">
          {reasons.map((r, i) => {
            const Icon = !r.decisive ? Info : r.granted ? CheckCircle2 : XCircle
            const color = !r.decisive ? 'text-[var(--text-tertiary)]' : r.granted ? 'text-[var(--success)]' : 'text-[var(--error)]'
            return (
              <li key={i} className="flex items-start gap-3 rounded-md border border-[var(--surface-3)] px-3 py-2.5">
                <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${color}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-body text-[var(--text-primary)]">
                    <span className="sr-only">{!r.decisive ? tr('Note:') : r.granted ? tr('Grants:') : tr('Does not grant:')}</span>{r.text}
                  </p>
                  {r.link && <Link href={r.link} className="text-caption text-[var(--brand-500)] hover:underline">{tr('Open the setting')}</Link>}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
