'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown, Settings } from 'lucide-react'
import { useProjects } from '@/hooks/use-project-admin'
import { useActiveModules } from '@/hooks/use-modules'
import { useFeatures } from '@/hooks/use-features'
import { topNavItems } from '@/lib/module-panels'

import { ADMIN_LINKS, NAV_GROUPS, type NavGroup } from '@/lib/routes'
import { useTerm } from '@/hooks/use-term'
import { useI18n } from '@/hooks/use-i18n'

const item = 'block px-3 py-2 rounded-md text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors'

function Menu({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right' }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        className={`absolute top-full mt-1 min-w-[240px] z-50 p-1.5 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
      >
        {children}
      </div>
    </>
  )
}

function Group({ group, pathname }: { group: NavGroup; pathname: string }) {
  const { tr } = useI18n();

  const [open, setOpen] = useState(false)
  const { t } = useTerm()
  const { data: projects = [] } = useProjects()
  const active = group.match.some((m) => pathname === m || pathname.startsWith(m + '/'))
  const close = () => setOpen(false)
  const base = `relative h-header px-3 flex items-center gap-1 text-sm font-medium transition-colors ${
    active ? 'text-[var(--brand-700)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
  }`
  const underline = active ? <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-[var(--brand-600)]" /> : null

  if (group.href) {
    return <Link href={group.href} className={base}>{t(group.label)}{underline}</Link>
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className={base} aria-haspopup="menu" aria-expanded={open}>
        {t(group.label)}
        <ChevronDown className="w-3.5 h-3.5 opacity-60" />
        {underline}
      </button>
      <Menu open={open} onClose={close}>
        {group.projects ? (
          <>
            <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr('Recent')}</div>
            {projects.slice(0, 6).map((p) => (
              <Link key={p.id} href={`/projects/${p.key}`} onClick={close} className={`${item} flex items-center gap-2`}>
                <span className="inline-flex w-5 h-5 rounded bg-[var(--brand-50)] text-[var(--brand-700)] text-[10px] font-bold items-center justify-center">
                  {p.key.slice(0, 2)}
                </span>
                <span className="truncate">{p.name}</span>
                <span className="ml-auto text-xs text-[var(--text-tertiary)]">{p.key}</span>
              </Link>
            ))}
            <div className="my-1 border-t border-[var(--surface-3)]" />
            <Link href="/projects" onClick={close} className={item}>{tr('View all projects')}</Link>
          </>
        ) : (
          group.items?.map((l) => (
            <Link key={l.href} href={l.href} onClick={close} className={item}>
              <span className="block text-[var(--text-primary)]">{t(l.label)}</span>
              {l.hint && <span className="block text-xs text-[var(--text-tertiary)]">{t(l.hint)}</span>}
            </Link>
          ))
        )}
      </Menu>
    </div>
  )
}

export function TopNav() {
  const { tr } = useI18n();

  const pathname = usePathname() || ''
  const { data: modules = [] } = useActiveModules()
  const { isEnabled } = useFeatures()
  return (
    <nav className="hidden min-[1440px]:flex items-stretch h-header" aria-label={tr('Primary')}>
      {NAV_GROUPS.filter((g) => isEnabled(g.feature)).map((g) => <Group key={g.label} group={{ ...g, items: g.items?.filter((l) => isEnabled(l.feature)) }} pathname={pathname} />)}
      {topNavItems(modules).length > 0 && (
        // Modules share one "Apps" menu (like Jira) so the bar does not overflow as modules are added.
        <Group pathname={pathname} group={{ label: tr('Apps'), match: ['/m'], items: topNavItems(modules).map((n) => ({ label: n.title, href: n.href })) }} />
      )}
    </nav>
  )
}

/** The gear menu: a short list of where administrators go most, and one link to everything (the full, sectioned menu lives on the Administration pages). */
const QUICK_ADMIN: Array<{ label: string; href: string }> = [
  { label: 'Users', href: '/admin?tab=users' },
  { label: 'All projects', href: '/projects' },
  { label: 'Workflows', href: '/admin/workflows' },
  { label: 'Permission schemes', href: '/admin?tab=permissions' },
  { label: 'Instance settings', href: '/admin/settings' },
  { label: 'Licence', href: '/admin/license' },
]

export function AdminMenu() {
  const [open, setOpen] = useState(false)
  const { tr } = useI18n()
  return (
    <div className="relative hidden sm:block">
      <button onClick={() => setOpen(!open)} className="veqsio-btn-ghost p-2" title={tr('Administration')} aria-haspopup="menu" aria-expanded={open}>
        <Settings className="w-5 h-5" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} align="right">
        <Link href="/admin" onClick={() => setOpen(false)} className={`${item} font-semibold text-[var(--text-primary)]`}>{tr('Administration')}</Link>
        <Link href="/settings" onClick={() => setOpen(false)} className={item}>{tr('Personal settings')}</Link>
        <div className="mt-1 border-t border-[var(--surface-3)] pt-1">
          <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr('Quick links')}</div>
          {QUICK_ADMIN.map((l) => <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={item}>{tr(l.label)}</Link>)}
        </div>
        <div className="mt-1 border-t border-[var(--surface-3)] pt-1">
          <Link href="/admin" onClick={() => setOpen(false)} className={`${item} text-[var(--brand-600)]`}>{tr('All administration settings')} →</Link>
        </div>
      </Menu>
    </div>
  )
}
