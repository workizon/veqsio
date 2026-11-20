'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Search, Star } from 'lucide-react'
import { adminEntries, frequentEntries, loadUsage, recentEntries, recordUsage, saveUsage, searchAdmin, type AdminEntry, type UsageRecord } from '@/lib/admin-helper'
import { browserLocalStorage } from '@/lib/palette'

/** "Admin helper": one search box that finds administration pages and settings by name or intent. */
export function AdminSearch() {
  const { tr } = useI18n();

  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<UsageRecord[]>([])
  useEffect(() => { setUsage(loadUsage(browserLocalStorage())) }, [])

  const hits = searchAdmin(query)
  const open = (href: string) => {
    const next = recordUsage(usage, href)
    setUsage(next)
    saveUsage(browserLocalStorage(), next)
  }
  const all = adminEntries()
  const recent = recentEntries(usage, all)
  const frequent = frequentEntries(usage, all)

  const row = (e: AdminEntry, extra?: React.ReactNode) => (
    <li key={e.href}>
      <Link href={e.href} onClick={() => open(e.href)} className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-[var(--surface-2)]">
        <span className="text-body text-[var(--text-primary)]">{e.label}</span>
        {e.hint && <span className="text-caption text-[var(--text-tertiary)] truncate">{e.hint}</span>}
        {extra}
      </Link>
    </li>
  )

  return (
    <section aria-label={tr('Find an administration page')} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
        <input
          type="search" aria-label={tr('Search administration')} className="veqsio-input w-full !pl-9"
          placeholder={tr('Find a setting or say what you want to do, e.g. "add a custom field" or "reset password"')}
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { open(hits[0].entry.href); window.location.assign(hits[0].entry.href) } }}
        />
      </div>
      {query.trim() ? (
        hits.length ? <ul className="mt-2" aria-label={tr('Matches')}>{hits.map((h) => row(h.entry))}</ul>
          : <p className="mt-3 text-body text-[var(--text-secondary)]">{tr('Nothing matches "')}{query}{tr('". Try a shorter phrase such as "users", "workflow" or "permission".')}</p>
      ) : (recent.length > 0 || frequent.length > 0) && (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {recent.length > 0 && <div><h2 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wider text-[var(--text-tertiary)] px-3"><Clock className="w-3.5 h-3.5" />{tr('Recent')}</h2><ul>{recent.map((e) => row(e))}</ul></div>}
          {frequent.length > 0 && <div><h2 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wider text-[var(--text-tertiary)] px-3"><Star className="w-3.5 h-3.5" />{tr('Frequent')}</h2><ul>{frequent.map((e) => row(e))}</ul></div>}
        </div>
      )}
    </section>
  )
}
