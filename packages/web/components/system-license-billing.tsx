'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle, CreditCard, KeyRound, ShieldCheck, Users, XCircle } from 'lucide-react'
import { Spinner } from './spinner'

interface Licence {
  edition: string; state: string; plan: string; customer: string | null; expiresAt: string | null; message: string
  seats: number | null; seatsInUse: number
  featureList: Array<{ key: string; label: string; enabled: boolean; plan: string }>
}

/** Licence summary on the System page. The key itself is entered on the Licence page. */
export function SystemLicenseBilling() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-licence-summary'],
    queryFn: async () => {
      const r = await fetch('/rest/api/2/admin/license', { credentials: 'include' })
      if (!r.ok) throw new Error('Could not load the licence')
      return (await r.json()) as Licence
    },
  })
  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (error || !data) return <p role="alert" className="text-[var(--error)]">{tr('Could not load the licence information.')}</p>
  const on = data.featureList.filter((f) => f.enabled)
  const off = data.featureList.filter((f) => !f.enabled)
  const tile = 'rounded-lg bg-[var(--surface-2)] p-4 space-y-1'
  return (
    <div className="space-y-6">
      <div className="veqsio-card space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center"><CreditCard className="w-5 h-5 text-[var(--brand-500)]" aria-hidden="true" /></div>
            <div><h2 className="text-heading-2 capitalize text-[var(--text-primary)]">{data.edition} edition</h2><p className="text-body-sm text-[var(--text-secondary)]">{data.message}</p></div>
          </div>
          <Link href="/admin/license" className="veqsio-btn-secondary inline-flex items-center gap-2"><KeyRound className="w-4 h-4" aria-hidden="true" />{tr('Manage licence key')}</Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className={tile}><div className="flex items-center gap-2 text-[var(--text-secondary)]"><ShieldCheck className="w-4 h-4" aria-hidden="true" /><span className="text-sm font-medium">{tr('Status')}</span></div><p className="text-display capitalize text-[var(--text-primary)]">{data.state}</p></div>
          <div className={tile}><div className="flex items-center gap-2 text-[var(--text-secondary)]"><Users className="w-4 h-4" aria-hidden="true" /><span className="text-sm font-medium">{tr('Seats')}</span></div><p className="text-display text-[var(--text-primary)]">{data.seatsInUse}{data.seats ? ` / ${data.seats}` : ''}</p><p className="text-xs text-[var(--text-tertiary)]">{data.seats ? 'in use / licensed' : 'in use (no limit)'}</p></div>
          <div className={tile}><div className="text-sm font-medium text-[var(--text-secondary)]">{tr('Licensed to')}</div><p className="text-display text-[var(--text-primary)]">{data.customer ?? '—'}</p></div>
          <div className={tile}><div className="text-sm font-medium text-[var(--text-secondary)]">{tr('Valid until')}</div><p className="text-display text-[var(--text-primary)]">{data.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : 'No expiry'}</p></div>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-label={tr('Included features')}><h3 className="mb-2 text-heading-3 text-[var(--text-primary)]">{tr('Included features (')}{on.length})</h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{on.map((f) => <li key={f.key} className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><CheckCircle className="w-4 h-4 shrink-0 text-[var(--success)]" aria-hidden="true" />{f.label}</li>)}{on.length === 0 && <li className="text-sm text-[var(--text-tertiary)]">{tr('None, this is the community edition.')}</li>}</ul>
          </section>
          {off.length > 0 && (
            <section aria-label={tr('Not included')}><h3 className="mb-2 text-heading-3 text-[var(--text-primary)]">{tr('Not included (')}{off.length})</h3>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{off.map((f) => <li key={f.key} className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />{f.label} <span className="text-xs">({f.plan})</span></li>)}</ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
