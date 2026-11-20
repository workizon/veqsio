'use client'

import { OfflineReading } from '@/components/offline-reading'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { useI18n, setUserLocale } from '@/hooks/use-i18n'
import { LOCALES, isLocale } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { pushSupported, currentPushSubscription, enablePush, disablePush } from '@/lib/push'
import { PushPreferences } from '@/components/push-preferences'

export default function PersonalSettingsPage() {
  const { locale, tr, stored } = useI18n()
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [canPush, setCanPush] = useState(false) // decided after mount: the server cannot know what this browser supports
  useEffect(() => { setCanPush(pushSupported()) }, [])
  useEffect(() => { if (canPush) currentPushSubscription().then((s) => setPushOn(!!s)).catch(() => {}) }, [canPush])
  const togglePush = async () => {
    setPushBusy(true); setPushError(null)
    try { if (pushOn) await disablePush(); else await enablePush(); setPushOn(!pushOn) }
    catch (e: any) { setPushError(e?.message || tr('Could not change push notifications')) }
    finally { setPushBusy(false) }
  }
  return (
    <AppLayout>
      <div className="max-w-xl">
        <PageHeader breadcrumb={[{ label: tr('Personal settings') }]} title={tr('Personal settings')} />
        <section className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-4 sm:p-5">
        <label className="block text-sm font-semibold mb-2" htmlFor="lang">{tr('Language')}</label>
        <select id="lang" className="veqsio-input w-full" value={stored ?? ''} onChange={(e) => setUserLocale(isLocale(e.target.value) ? e.target.value : null)}>
          <option value="">{`Auto (${LOCALES.find((l) => l.id === locale)?.name})`}</option>
          {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <p className="text-xs text-[var(--text-tertiary)] mt-2">{tr('Applies to menus and common labels in this browser. E-mails and notifications are not translated yet.')}</p>
        </section>
        <section className="mt-4 rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-4 sm:p-5">
        <h2 className="text-sm font-semibold mb-1">{tr('Push notifications')}</h2>
        {canPush ? (
          <>
            <p className="text-xs text-[var(--text-tertiary)] mb-3">{tr('Get a browser notification when an issue is assigned to you, you are @mentioned, or someone comments on an issue you follow. Turning push on or off applies to this browser only; the choices below apply to all your browsers.')}</p>
            <button type="button" className="veqsio-btn-secondary" disabled={pushBusy} onClick={togglePush} aria-pressed={pushOn}>
              {pushOn ? tr('Turn off push notifications') : tr('Turn on push notifications')}
            </button>
            {pushError && <p role="alert" className="text-xs text-[var(--error)] mt-2">{pushError}</p>}
          </>
        ) : (
          <p className="text-xs text-[var(--text-tertiary)]">{tr('This browser does not support push notifications (they also need HTTPS).')}</p>
        )}
        </section>
        {canPush && <PushPreferences />}
        <OfflineReading />
      </div>
    </AppLayout>
  )
}
