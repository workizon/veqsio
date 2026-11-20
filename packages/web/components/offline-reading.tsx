'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { clearOfflineCache, offlineCount, offlineEnabled, setOfflineEnabled } from '@/lib/offline-cache'

/** Personal settings: keep the issues I open readable without a connection, on this device. */
export function OfflineReading() {
  const { tr } = useI18n();

  const [on, setOn] = useState(false)
  const [count, setCount] = useState(0)
  useEffect(() => { setOn(offlineEnabled()); void offlineCount().then(setCount) }, [])
  const toggle = async (v: boolean) => {
    setOn(v); setOfflineEnabled(v)
    if (!v) { await clearOfflineCache(); setCount(0) }
  }
  return (
    <section className="mt-4 rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-4 sm:p-5" aria-labelledby="offline-h">
      <h2 id="offline-h" className="text-sm font-semibold mb-1">{tr('Offline reading')}</h2>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        {tr('Keep the text of the issues you open (up to 50, no attachments, no comments) on this device, so that you can read them without a connection from the page that shows when you are offline. They are removed when you sign out or switch this off. Leave it off on a shared computer.')}
      </p>
      <label className="flex items-start justify-between gap-4 py-1 cursor-pointer">
        <span className="text-sm">{tr('Keep recently opened issues on this device')}</span>
        <input type="checkbox" role="switch" aria-checked={on} checked={on} onChange={(e) => void toggle(e.target.checked)} className="peer sr-only" />
        <span aria-hidden="true" className="relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full bg-[var(--surface-3)] transition-colors peer-checked:bg-[var(--brand-500)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--brand-400)] after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4" />
      </label>
      {on && (
        <div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-secondary)]" aria-live="polite">
          <span>{count === 0 ? tr('Nothing saved yet: open an issue.') : count === 1 ? tr('{n} issue saved on this device.', { n: count }) : tr('{n} issues saved on this device.', { n: count })}</span>
          {count > 0 && <button type="button" className="veqsio-btn-ghost !min-h-0 text-xs" onClick={() => void clearOfflineCache().then(() => setCount(0))}>{tr('Remove them now')}</button>}
        </div>
      )}
    </section>
  )
}
