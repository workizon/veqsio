'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useActiveModules } from '@/hooks/use-modules'
import { useFeatures } from '@/hooks/use-features'
import { useI18n } from '@/hooks/use-i18n'
import { adminSections, isActiveAdminLink } from '@/lib/admin-nav'
import { usePublicSettings } from '@/hooks/use-instance-settings'

/** Pages that only make sense on a self-hosted install (the API refuses them on Veqsio Cloud as well). */
const CLOUD_HIDDEN = new Set(['/admin/health'])

/** Sectioned navigation shown on every administration page. */
export function AdminSidebar() {
  const pathname = usePathname() || ''
  const tab = useSearchParams()?.get('tab') ?? null
  const { data: modules = [] } = useActiveModules()
  const { isEnabled } = useFeatures()
  const { tr } = useI18n()
  const cloud = !!usePublicSettings().data?.cloud
  const sections = useMemo(() => {
    const moduleLinks = modules.flatMap((m) => m.web.adminPages.map((a) => ({ label: a.title, href: `/m/${m.id}/${a.path}`, hint: a.description })))
    return adminSections(moduleLinks)
      .map((s) => ({ ...s, items: s.items.filter((i) => isEnabled(i.feature) && !(cloud && CLOUD_HIDDEN.has(i.href))) }))
      .filter((s) => s.items.length > 0)
  }, [modules, isEnabled, cloud])

  const nav = (
    <nav aria-label={tr('Administration')} className="space-y-5">
      <Link href="/admin" className={`block rounded-md px-3 py-1.5 text-sm font-semibold ${pathname === '/admin' && !tab ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-primary)] hover:bg-[var(--surface-2)]'}`}>{tr('Administration home')}</Link>
      {sections.map((s) => (
        <div key={s.id}>
          <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr(s.title)}</p>
          <ul>
            {s.items.map((i) => {
              const active = isActiveAdminLink(i.href, pathname, tab)
              return (
                <li key={i.href}>
                  <Link href={i.href} aria-current={active ? 'page' : undefined} title={i.hint ? tr(i.hint) : undefined} className={`block rounded-md px-3 py-1.5 text-sm ${active ? 'bg-[var(--brand-50)] font-medium text-[var(--brand-700)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'}`}>{tr(i.label)}</Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )

  return (
    <>
      <aside className="hidden lg:block w-60 shrink-0 self-start sticky top-[calc(var(--header-height,56px)+1.5rem)] max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">{nav}</aside>
      <details className="lg:hidden mb-4 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-3">
        <summary className="cursor-pointer text-sm font-medium">{tr('Administration menu')}</summary>
        <div className="mt-3">{nav}</div>
      </details>
    </>
  )
}
