'use client'

import { useEffect, useState } from 'react'
import { usePublicSettings } from '@/hooks/use-instance-settings'

const STYLE = {
  info: 'bg-[var(--brand-50)] text-[var(--brand-700)]',
  warning: 'bg-amber-100 text-amber-900',
  critical: 'bg-red-100 text-red-900',
} as const

/** Milliseconds until the next reset: resets run on the clock (every `minutes`, counted from the hour). */
export function msToNextReset(now: number, minutes: number): number {
  const step = Math.max(1, minutes) * 60_000
  return Math.ceil((now + 1) / step) * step - now
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** Public demo: states that the data is reset on a schedule and counts down to the next reset. */
function DemoBanner({ minutes }: { minutes: number }) {
  const [offset, setOffset] = useState(0) // server clock minus this browser's clock
  const [now, setNow] = useState<number | null>(null) // set after mount, so that the server and the first client render agree
  useEffect(() => {
    fetch('/health', { cache: 'no-store' }).then((r) => { const d = r.headers.get('date'); if (d) setOffset(Date.parse(d) - Date.now()) }).catch(() => {})
  }, [])
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = now === null ? minutes * 60_000 - 60_000 : msToNextReset(now + offset, minutes)
  const resetting = left > minutes * 60_000 - 30_000 // the first half minute after a reset: the API restarts
  // reload once when the reset has just happened, so the visitor lands in the fresh data
  useEffect(() => {
    if (!resetting) return
    const t = setTimeout(() => window.location.reload(), 20_000)
    return () => clearTimeout(t)
  }, [resetting])
  const soon = left < 60_000
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    try { if (sessionStorage.getItem('demo-banner-dismissed') === '1') setDismissed(true) } catch { /* storage unavailable */ }
  }, [])
  if (dismissed) return null
  return (
    <div role="status" className={`relative py-2 pl-4 pr-11 text-center text-sm font-medium ${soon || resetting ? 'bg-amber-100 text-amber-900' : STYLE.info}`}>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => { setDismissed(true); try { sessionStorage.setItem('demo-banner-dismissed', '1') } catch { /* ignore */ } }}
        className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none opacity-70 hover:opacity-100 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)]"
      >
        ×
      </button>
      Public demo: the data is reset every {minutes === 60 ? 'hour' : `${minutes} minutes`}. {resetting
        ? 'The demo is being reset right now, the page reloads by itself.'
        : <>Next reset in <strong className="tabular-nums" data-testid="demo-reset-countdown">{formatCountdown(left)}</strong>.</>}
      {' '}E-mail, webhooks, imports and other outgoing integrations are switched off.
    </div>
  )
}

/** Administrator announcement, rendered as plain text above the page (the demo banner replaces it on a public demo). */
export function AnnouncementBanner() {
  const { data } = usePublicSettings()
  if (data?.maintenance) return <div role="alert" className={`px-4 py-2 text-center text-sm font-medium ${STYLE.critical}`}>Maintenance mode is on: only administrators can work right now. {data.maintenance.message}</div>
  if (data?.demo) return <DemoBanner minutes={data.demo.resetEveryMinutes} />
  const a = data?.announcement
  if (!a) return null
  return <div role={a.level === 'info' ? 'status' : 'alert'} className={`px-4 py-2 text-center text-sm font-medium ${STYLE[a.level] ?? STYLE.info}`}>{a.message}</div>
}
