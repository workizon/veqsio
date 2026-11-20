'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useCallback, useEffect, useState } from 'react'

interface Prefs {
  events: Record<string, boolean>
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timezone: string
  kinds: Array<{ key: string; label: string }>
}

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const zones = (current: string): string[] => {
  let all: string[] = []
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { all = [] }
  return [...new Set(['UTC', browserZone(), current, ...all])].filter(Boolean).sort()
}

const Switch = ({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) => (
  <label className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
    <span className="min-w-0">
      <span className="block text-sm text-[var(--text-primary)]">{label}</span>
      {hint && <span className="block text-xs text-[var(--text-tertiary)] mt-0.5">{hint}</span>}
    </span>
    <input type="checkbox" role="switch" aria-checked={checked} checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
    <span aria-hidden="true" className="relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full bg-[var(--surface-3)] transition-colors peer-checked:bg-[var(--brand-500)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--brand-400)] after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4" />
  </label>
)

/**
 * Which kinds of push notification I want and when to keep quiet. Stored on my account, so it applies to every browser I turned
 * push on in. Every change is saved at once and announced to screen readers.
 */
export function PushPreferences() {
  const { tr } = useI18n();

  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    fetch('/rest/api/2/push/preferences', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your push settings'))))
      .then((p: Prefs) => { if (live) setPrefs(p) })
      .catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])

  const save = useCallback(async (patch: Record<string, unknown>) => {
    setError(''); setMessage('')
    try {
      const r = await fetch('/rest/api/2/push/preferences', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!r.ok) { const b = await r.json().catch(() => null); throw new Error(b?.errorMessages?.[0] || b?.error?.issues?.[0]?.message || 'Could not save') }
      setPrefs(await r.json()); setMessage('Saved')
    } catch (e: any) { setError(e?.message || 'Could not save') }
  }, [])

  if (error && !prefs) return <p role="alert" className="text-xs text-[var(--error)] mt-3">{tr(error)}</p>
  if (!prefs) return <p className="text-xs text-[var(--text-tertiary)] mt-3" aria-busy="true">{tr('Loading your push settings…')}</p>

  const card = 'rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-4 sm:p-5'
  return (
    <div className="mt-4 space-y-4" aria-label={tr('Push notification settings')}>
      <fieldset className={card}>
        <legend className="sr-only">{tr('Notify me when')}</legend>
        <h3 className="text-sm font-semibold mb-1" aria-hidden="true">{tr('Notify me when')}</h3>
        <div className="divide-y divide-[var(--surface-3)]">
          {prefs.kinds.map((k) => (
            <Switch key={k.key} label={tr(k.label)} checked={prefs.events[k.key] !== false} onChange={(v) => void save({ events: { [k.key]: v } })} />
          ))}
        </div>
      </fieldset>

      <fieldset className={card}>
        <legend className="sr-only">{tr('Quiet hours')}</legend>
        <h3 className="text-sm font-semibold mb-1" aria-hidden="true">{tr('Quiet hours')}</h3>
        <Switch label={tr('Do not send push notifications during these hours')} checked={prefs.quietEnabled}
          onChange={(v) => void save({ quietEnabled: v, ...(v && prefs.timezone === 'UTC' ? { timezone: browserZone() } : {}) })} />
        <div className={`mt-2 grid grid-cols-2 gap-3 transition-opacity ${prefs.quietEnabled ? '' : 'opacity-50'}`}>
          <label className="text-xs font-medium text-[var(--text-secondary)]">{tr('From')} <input type="time" className="veqsio-input block w-full mt-1" disabled={!prefs.quietEnabled} value={prefs.quietStart} onChange={(e) => { if (e.target.value) void save({ quietStart: e.target.value }) }} />
          </label>
          <label className="text-xs font-medium text-[var(--text-secondary)]">{tr('To')} <input type="time" className="veqsio-input block w-full mt-1" disabled={!prefs.quietEnabled} value={prefs.quietEnd} onChange={(e) => { if (e.target.value) void save({ quietEnd: e.target.value }) }} />
          </label>
          <label className="col-span-2 text-xs font-medium text-[var(--text-secondary)]">{tr('Time zone')} <select className="veqsio-input block w-full mt-1" disabled={!prefs.quietEnabled} value={prefs.timezone} onChange={(e) => void save({ timezone: e.target.value })}>
              {zones(prefs.timezone).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
        </div>
        <p className="text-xs text-[var(--text-tertiary)] mt-3">{tr('The window may cross midnight, for example 22:00 to 07:00. On-call pages are still delivered during quiet hours; switch that one off above if you do not want them at all.')}</p>
      </fieldset>
      <p role="status" aria-live="polite" className={error ? 'text-xs text-[var(--error)]' : 'text-xs text-[var(--text-tertiary)] min-h-[1rem]'}>{tr(error || message)}</p>
    </div>
  )
}
