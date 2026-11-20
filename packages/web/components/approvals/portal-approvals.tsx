'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { DecisionForm } from './shared'
import { usePortalApprovals, usePortalDecide } from '@/hooks/use-approvals'
import { STATUS_LABEL, type ApprovalStatus } from '@/lib/approvals'

/** Status chip colours from the theme tokens (light and dark); the text always says the status as well. */
const CHIP: Record<ApprovalStatus, string> = {
  pending: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning)] ring-[color-mix(in_srgb,var(--warning)_30%,transparent)]',
  approved: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)] ring-[color-mix(in_srgb,var(--success)_28%,transparent)]',
  declined: 'bg-[color-mix(in_srgb,var(--error)_13%,transparent)] text-[var(--error)] ring-[color-mix(in_srgb,var(--error)_28%,transparent)]',
  cancelled: 'bg-[var(--surface-2)] text-[var(--text-secondary)] ring-[var(--surface-3)]',
  expired: 'bg-[var(--surface-2)] text-[var(--text-secondary)] ring-[var(--surface-3)]',
}

/**
 * Portal box for customers who are approvers. Without `requestKey` it lists what waits for the customer's decision
 * (portal home); with it, the customer's approvals on that request. Renders nothing when there are none.
 * Looks like the other portal sections: rounded card, heading, one row per approval; a brand accent marks what needs an answer.
 */
export function PortalApprovals({ slug, requestKey }: { slug: string; requestKey?: string }) {
  const { tr } = useI18n();

  const list = usePortalApprovals(slug, requestKey)
  const decide = usePortalDecide(slug)
  const [errors, setErrors] = useState<Record<number, string>>({})
  const items = list.data?.values ?? []
  if (items.length === 0) return null
  const waiting = items.filter((a) => a.canDecide).length
  const headingId = `pa-${requestKey ?? 'home'}`

  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-5 space-y-4 ${waiting > 0 ? 'border-l-[3px] border-l-[var(--brand-500)]' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-heading-3 text-[var(--text-primary)]">{requestKey ? tr('Approvals') : tr('Waiting for my approval')}</h2>
        {waiting > 0 && <span className="rounded-full bg-[var(--brand-50)] px-2 py-0.5 text-caption font-semibold text-[var(--brand-700)] ring-1 ring-inset ring-[var(--brand-100)]">{waiting} {tr('to decide')}</span>}
      </div>
      <ul className="space-y-3">
        {items.map((a) => (
          <li key={a.id} className="space-y-3 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="text-body font-semibold text-[var(--text-primary)]">{a.name}</strong>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ring-1 ring-inset ${CHIP[a.status] ?? CHIP.cancelled}`}>{STATUS_LABEL[a.status] ? tr(STATUS_LABEL[a.status]) : a.status}</span>
            </div>
            {!requestKey && (
              <Link
                href={`/portal/${slug}/requests/${a.request.key}`}
                className="group flex min-h-[44px] items-center gap-2 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] px-3 py-2 text-body-sm hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)]"
              >
                <span className="font-mono text-caption text-[var(--text-tertiary)]">{a.request.key}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{a.request.summary}</span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
              </Link>
            )}
            {a.myDecision && <p className="text-body-sm text-[var(--text-secondary)]">{tr('You')} {a.myDecision.decision} {tr('this request.')}</p>}
            {a.canDecide && (
              <DecisionForm
                touch
                busy={decide.isPending}
                error={errors[a.id]}
                onDecide={(decision, comment) => {
                  setErrors((e) => ({ ...e, [a.id]: '' }))
                  decide.mutate({ id: a.id, decision, comment }, { onError: (e) => setErrors((er) => ({ ...er, [a.id]: e.message })) })
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
