'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { describeDraftAge } from '@/lib/drafts'

/** "Restored draft from 5 minutes ago · Discard" bar shown above a form whose fields were refilled from a saved draft. */
export function DraftNotice({ savedAt, onDiscard, className = '' }: { savedAt: number | null; onDiscard: () => void; className?: string }) {
  const { tr } = useI18n();

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (savedAt === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [savedAt])
  if (savedAt === null) return null
  const time = new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div
      role="status"
      data-testid="draft-notice"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[var(--surface-3)] bg-[var(--surface-1)] px-3 py-2 text-caption text-[var(--text-secondary)] ${className}`}
    >
      <span>
        {tr('Restored draft from')} <time dateTime={new Date(savedAt).toISOString()} title={time}>{describeDraftAge(savedAt, now)}</time>
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={onDiscard} className="font-medium text-[var(--brand-600)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] rounded">
        {tr('Discard')} </button>
    </div>
  )
}
