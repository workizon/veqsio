'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useState } from 'react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { DecisionForm, StatusChip } from '@/components/approvals/shared'
import { useDecide, useMyApprovals } from '@/hooks/use-approvals'
import { ruleLabel } from '@/lib/approvals'

export default function MyApprovalsPage() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useMyApprovals()
  const decide = useDecide()
  const [errors, setErrors] = useState<Record<number, string>>({})
  const items = data?.values ?? []

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('My approvals')} description={tr('Requests waiting for your decision.')} />
        {isLoading && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}
        {error && <p role="alert" className="text-[var(--error)]">{error.message}</p>}
        {data && items.length === 0 && <p className="veqsio-card p-6 text-[var(--text-tertiary)]">{tr('Nothing is waiting for your decision.')}</p>}
        <ul className="space-y-3" aria-label={tr('Pending approvals')}>
          {items.map((a) => (
            <li key={a.id} className="veqsio-card p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{a.name}</strong> <StatusChip status={a.status} />
                <span className="text-xs text-[var(--text-tertiary)]">{ruleLabel(a.rule, a.ruleThreshold)}</span>
              </div>
              <p className="text-sm">
                {a.portalSlug
                  ? <Link className="text-[var(--brand-500)] hover:underline" href={`/portal/${a.portalSlug}/requests/${a.issue.key}`}>{a.issue.key}</Link>
                  : <Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${a.issue.key}`}>{a.issue.key}</Link>}
                {' '}{a.issue.summary} <span className="text-[var(--text-tertiary)]">· {a.project.name}</span>
              </p>
              <p className="text-xs text-[var(--text-tertiary)]">{tr('Requested')} {new Date(a.created).toLocaleString()}{a.expires ? ` · expires ${new Date(a.expires).toLocaleString()}` : ''}</p>
              <DecisionForm
                busy={decide.isPending}
                error={errors[a.id]}
                onDecide={(decision, comment) => {
                  setErrors((e) => ({ ...e, [a.id]: '' }))
                  decide.mutate({ id: a.id, decision, comment }, {
                    onSuccess: () => toast(decision === 'approved' ? 'Approved' : 'Declined', 'success'),
                    onError: (e) => setErrors((er) => ({ ...er, [a.id]: e.message })),
                  })
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    </AppLayout>
  )
}
