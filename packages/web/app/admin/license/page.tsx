'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { confirmDialog } from '@/components/dialogs'

interface LicenseView {
  edition: 'community' | 'enterprise'
  state: string
  plan: string
  customer: string | null
  licenseId: string | null
  expiresAt: string | null
  daysToExpiry: number | null
  expiryWarning: boolean
  keyStatus: 'not_set' | 'valid' | 'grace' | 'expired' | 'invalid_signature' | 'key_unknown' | 'invalid'
  keySource: string | null
  message: string | null
  featureList: Array<{ key: string; label: string; enabled: boolean; plan: string }>
  seats: number | null
  seatsEnforced: boolean
  seatsInUse: number
  seatsAvailable: number | null
  cloudManaged?: boolean
}

interface CloudStatus {
  cloud: boolean
  plan: string
  limits: { users: number | null; storageBytes: number | null; attachmentMaxBytes: number | null; emailsPerHour: number | null; apiRequestsPerMinute: number | null }
  usage: { activeUsers: number; issues: number; projects: number; storageBytes: number; attachments: number; emailsLastHour: number } | null
}

interface UpdatesView {
  version: string
  build: string
  settings: { mode: string; windowDay: string; windowHourUtc: number; notifyAdmins: boolean }
  release: { status: 'not_configured' | 'untrusted' | 'unreachable' | 'ok'; latest?: string; updateAvailable?: boolean; securityUpdate?: boolean; canUpgradeDirectly?: boolean; notes?: Array<{ version: string; security: boolean; notes: string }>; reason?: string; error?: string }
}

const fmtMb = (b: number | null, unlimited: string) => (b === null ? unlimited : `${Math.round(b / 1048576).toLocaleString()} MB`)
const jget = <T,>(url: string) => fetch(url, { credentials: 'include' }).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as T })

const STATUS_TEXT: Record<LicenseView['keyStatus'], string> = {
  not_set: 'No licence key is set (community edition).',
  valid: 'The licence key is valid.',
  grace: 'The licence has expired and is in its grace period.',
  expired: 'The licence has expired.',
  invalid_signature: 'The licence key has an invalid signature.',
  key_unknown: 'The licence was signed with an unknown key.',
  invalid: 'The licence key is not valid.',
}

async function api<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/rest/api/2/admin/license', { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.errorMessages?.[0] ?? (res.status === 403 ? 'System administrator rights are required' : res.statusText))
  return body as T
}

export default function LicensePage() {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const view = useQuery({ queryKey: ['admin', 'license'], queryFn: () => api<LicenseView>() })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin', 'license'] }); qc.invalidateQueries({ queryKey: ['license'] }) }
  const apply = useMutation({
    mutationFn: () => api<LicenseView>({ method: 'PUT', body: JSON.stringify({ key: key.trim() }) }),
    onSuccess: () => { setKey(''); refresh(); toast(tr('Licence applied'), 'success') },
    onError: (e) => toast(tr((e as Error).message), 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api<LicenseView>({ method: 'DELETE' }),
    onSuccess: () => { refresh(); toast(tr('Licence key removed'), 'success') },
    onError: (e) => toast(tr((e as Error).message), 'error'),
  })
  const v = view.data
  const cloudStatus = useQuery({ queryKey: ['cloud', 'status'], queryFn: () => jget<CloudStatus>('/rest/api/2/cloud/status'), enabled: !!v?.cloudManaged })
  const updates = useQuery({ queryKey: ['admin', 'updates'], queryFn: () => jget<UpdatesView>('/rest/api/2/admin/updates') })
  const cs = cloudStatus.data
  const up = updates.data

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Licence')} />
        {view.isLoading && <Spinner />}
        {view.error && <p role="alert" className="text-[var(--error)]">{tr((view.error as Error).message)}</p>}

        {v && (
          <>
            {v.expiryWarning && (
              <div role="alert" className="rounded border border-amber-300 bg-amber-50 text-amber-900 p-3 flex gap-2 text-sm">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
                {v.state === 'grace' ? tr('The licence has expired and is running in its grace period.') : tr(v.daysToExpiry === 1 ? 'The licence expires in {n} day.' : 'The licence expires in {n} days.', { n: v.daysToExpiry })} {tr('Enterprise features will stop accepting new use afterwards; your data stays readable.')} </div>
            )}

            <section className="veqsio-card p-5 space-y-3">
              <div className="flex items-center gap-2">
                {v.edition === 'enterprise' ? <CheckCircle2 className="w-5 h-5 text-green-700" aria-hidden /> : <Lock className="w-5 h-5 text-[var(--text-tertiary)]" aria-hidden />}
                <h2 className="text-heading-3">{v.edition === 'enterprise' ? tr('Enterprise edition') : tr('Community edition')}</h2>
              </div>
              <p className="text-sm text-[var(--text-secondary)]">{tr(STATUS_TEXT[v.keyStatus])}{v.message && v.keyStatus !== 'valid' ? ` ${v.message}` : ''}</p>
              <dl className="grid grid-cols-[10rem_1fr] gap-x-6 gap-y-1 text-sm">
                {v.customer && (<><dt className="text-[var(--text-tertiary)]">{tr('Licensee')}</dt><dd>{v.customer}</dd></>)}
                {v.plan && v.edition === 'enterprise' && (<><dt className="text-[var(--text-tertiary)]">{tr('Plan')}</dt><dd className="capitalize">{v.plan}</dd></>)}
                {v.expiresAt && (<><dt className="text-[var(--text-tertiary)]">{tr('Expires')}</dt><dd>{new Date(v.expiresAt).toLocaleDateString()}{v.daysToExpiry !== null ? ` (${tr('{n} days', { n: v.daysToExpiry })})` : ''}</dd></>)}
                <dt className="text-[var(--text-tertiary)]">{tr('Users')}</dt>
                <dd>{v.seatsInUse}{v.seatsEnforced ? ' ' + tr('of {seats} ({available} available)', { seats: v.seats, available: v.seatsAvailable }) : ' ' + tr('(no seat limit)')}</dd>
                {v.keySource && (<><dt className="text-[var(--text-tertiary)]">{tr('Key source')}</dt><dd>{v.keySource}</dd></>)}
              </dl>
            </section>

            {v.cloudManaged && cs && (
              <section className="veqsio-card p-5 space-y-3" aria-label={tr('Plan and usage')}>
                <h2 className="text-heading-3">{tr('Veqsio Cloud plan and usage')}</h2>
                <p className="text-sm text-[var(--text-secondary)]">{tr('The licence and the server are managed by Veqsio Cloud. Billing and plan changes are in your cloud account.')}</p>
                <dl className="grid grid-cols-[10rem_1fr] gap-x-6 gap-y-1 text-sm">
                  <dt className="text-[var(--text-tertiary)]">{tr('Plan')}</dt><dd className="capitalize">{cs.plan}</dd>
                  <dt className="text-[var(--text-tertiary)]">{tr('Users')}</dt><dd>{tr('{used} of {limit}', { used: cs.usage ? cs.usage.activeUsers : v.seatsInUse, limit: cs.limits.users ?? tr('unlimited') })}</dd>
                  <dt className="text-[var(--text-tertiary)]">{tr('Storage')}</dt><dd>{cs.usage ? fmtMb(cs.usage.storageBytes, tr('unlimited')) : '…'} {tr('of')} {fmtMb(cs.limits.storageBytes, tr('unlimited'))}</dd>
                  <dt className="text-[var(--text-tertiary)]">{tr('Largest file')}</dt><dd>{fmtMb(cs.limits.attachmentMaxBytes, tr('unlimited'))}</dd>
                  <dt className="text-[var(--text-tertiary)]">{tr('E-mails per hour')}</dt><dd>{cs.limits.emailsPerHour ?? tr('unlimited')}</dd>
                  {cs.usage && (<><dt className="text-[var(--text-tertiary)]">{tr('Issues / projects')}</dt><dd>{cs.usage.issues.toLocaleString()} / {cs.usage.projects.toLocaleString()}</dd></>)}
                </dl>
              </section>
            )}

            {up && (
              <section className="veqsio-card p-5 space-y-3" aria-label={tr('Version and updates')}>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-heading-3">{tr('Version')} {up.version}</h2>
                  <span className="text-xs text-[var(--text-tertiary)]">{tr('build')} {up.build}</span>
                  {up.release.status === 'ok' && up.release.updateAvailable && (
                    <span className={`text-xs rounded-full px-2 py-0.5 border ${up.release.securityUpdate ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
                      {up.release.securityUpdate ? tr('Security update available') : tr('Update available')}: {up.release.latest}
                    </span>
                  )}
                  {up.release.status === 'ok' && !up.release.updateAvailable && <span className="text-xs text-green-700">{tr('Up to date')}</span>}
                </div>
                {up.release.status === 'not_configured' && <p className="text-sm text-[var(--text-secondary)]">{tr('Update checks are not configured on this instance.')}</p>}
                {up.release.status === 'untrusted' && <p role="alert" className="text-sm text-[var(--error)]">{tr('The release list could not be verified (')}{up.release.reason}{tr(') and was ignored.')}</p>}
                {up.release.status === 'unreachable' && <p className="text-sm text-[var(--text-secondary)]">{tr('The release list could not be fetched right now.')}</p>}
                {up.release.status === 'ok' && up.release.notes && up.release.notes.length > 0 && (
                  <ul className="text-sm divide-y divide-[var(--surface-3)]">
                    {up.release.notes.slice(0, 5).map((r) => (<li key={r.version} className="py-1.5"><span className="font-medium">{r.version}</span>{r.security ? ' ' + tr('(security)') : ''} {r.notes}</li>))}
                  </ul>
                )}
                <p className="text-sm text-[var(--text-secondary)]">
                  {tr('Automatic updates:')} <strong>{up.settings.mode === 'off' ? tr('off') : up.settings.mode === 'security' ? tr('security fixes only') : tr('all releases')}</strong>
                  {up.settings.mode !== 'off' && <> {tr('· window')} {up.settings.windowDay === 'any' ? tr('every day') : up.settings.windowDay} {tr('at')} {String(up.settings.windowHourUtc).padStart(2, '0')}{tr(':00 UTC')}</>}
                  {' · '}<a className="text-[var(--brand-500)] hover:underline" href="/admin/settings">{tr('Change in instance settings')}</a>
                </p>
              </section>
            )}

            <section className="veqsio-card p-5 space-y-3">
              <h2 className="text-heading-3">{tr('Enterprise features')}</h2>
              <ul className="divide-y divide-[var(--surface-3)]">
                {v.featureList.map((f) => (
                  <li key={f.key} className="flex items-center justify-between py-2 text-sm">
                    <span>{f.label}</span>
                    <span className={f.enabled ? 'text-green-700 font-medium' : 'text-[var(--text-tertiary)]'}>{f.enabled ? tr('Included') : tr('Needs {plan} plan', { plan: f.plan })}</span>
                  </li>
                ))}
              </ul>
            </section>

            {!v.cloudManaged && (<section className="veqsio-card p-5 space-y-3">
              <h2 className="text-heading-3">{tr('Apply a licence key')}</h2>
              <label className="block text-sm space-y-1">{tr('Licence key')} <textarea className="veqsio-input w-full font-mono text-xs" rows={4} value={key} autoComplete="off" spellCheck={false}
                  placeholder={tr('VQL1.…')} onChange={(e) => setKey(e.target.value)} />
              </label>
              <div className="flex gap-2">
                <button className="veqsio-btn-primary" disabled={apply.isPending || key.trim().length < 10} onClick={() => apply.mutate()}>{tr('Apply key')}</button>
                {v.keyStatus !== 'not_set' && v.keySource === 'database' && (
                  <button className="veqsio-btn-secondary" disabled={remove.isPending} onClick={async () => (await confirmDialog(tr('Remove the licence key? Enterprise features will stop accepting new use.'))) && remove.mutate()}>{tr('Remove key')}</button>
                )}
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">{tr('The key is verified offline and is never shown again after saving.')}</p>
            </section>)}
          </>
        )}
      </div>
    </AppLayout>
  )
}
