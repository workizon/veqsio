'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { hasLicensedFeature, useLicenseStatus } from '@/hooks/use-license'

/**
 * Shows its children only when the instance's licence includes `feature`; otherwise an explanation instead of a
 * broken page. While the status loads nothing is flashed. Existing data is never hidden by this component: use it
 * around *creating or managing* enterprise functionality; use mode="banner" to keep existing data visible.
 */
export function FeatureGate({ feature, label, mode = 'block', children }: { feature: string; label?: string; mode?: 'block' | 'banner'; children: React.ReactNode }) {
  const { tr } = useI18n();

  const { data, isLoading } = useLicenseStatus()
  if (isLoading) return mode === 'banner' ? <>{children}</> : null
  if (hasLicensedFeature(data, feature)) return <>{children}</>
  const card = (
    <div role="status" className="veqsio-card p-6 flex items-start gap-4">
      <Lock className="w-6 h-6 text-[var(--text-tertiary)] shrink-0 mt-1" aria-hidden />
      <div className="space-y-2">
        <h2 className="text-heading-3">{label ?? tr('This feature')} {tr('needs an Enterprise licence')}</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          {tr('It is not part of the community edition. Your existing data stays available. Apply a licence key under')}{' '}
          <Link href="/admin/license" className="text-[var(--brand-500)] hover:underline">{tr('Admin > Licence')}</Link>{' '}
          {tr('to unlock it.')} </p>
      </div>
    </div>
  )
  // banner: explain, but keep existing data visible (the server refuses changes with 402)
  return mode === 'banner' ? <><div className="mb-4">{card}</div>{children}</> : card
}
