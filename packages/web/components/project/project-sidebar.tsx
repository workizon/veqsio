'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { useFeatures } from '@/hooks/use-features'
import { useI18n } from '@/hooks/use-i18n'
import { ProjectAvatar } from '@/components/project-avatar'
import { canAdministerProject, isActiveProjectLink, projectSettingsLinks, projectWorkLinks } from '@/lib/project-nav'

interface Perms { permissions?: Record<string, { havePermission?: boolean }> }

/** Left menu inside a project: the work links for everyone, and "Project settings" (all the settings, one click each) for project administrators. */
const COLLAPSED_KEY = 'veqsio-project-sidebar-collapsed'

export function ProjectSidebar({ projectKey }: { projectKey: string }) {
  // Collapsible like Jira's; without a saved choice it starts collapsed on screens too narrow for three columns.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(COLLAPSED_KEY)
      setCollapsed(v === null ? window.innerWidth < 1536 : v === '1')
    } catch { /* private mode */ }
  }, [])
  const toggle = () => setCollapsed((c) => {
    try { window.localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* private mode */ }
    return !c
  })
  const pathname = usePathname() || ''
  const tab = useSearchParams()?.get('tab') ?? null
  const { isEnabled } = useFeatures()
  const { tr } = useI18n()
  const project = useQuery({
    queryKey: ['project-brief', projectKey], staleTime: 60_000, retry: false,
    queryFn: async () => { const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}`, { credentials: 'include' }); return r.ok ? ((await r.json()) as { key: string; name: string; avatarUrls?: Record<string, string> }) : null },
  })
  const perms = useQuery({
    queryKey: ['project-permissions', projectKey], staleTime: 60_000, retry: false,
    queryFn: async () => { const r = await fetch(`/rest/api/2/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=PROJECT_ADMIN`, { credentials: 'include' }); return r.ok ? ((await r.json()) as Perms) : null },
  })
  const admin = canAdministerProject(perms.data?.permissions)
  const work = projectWorkLinks(projectKey).filter((l) => isEnabled(l.feature))
  const settings = admin ? projectSettingsLinks(projectKey, isEnabled) : []

  const cls = (active: boolean) => `block rounded-md px-3 py-1.5 text-sm ${active ? 'bg-[var(--brand-50)] font-medium text-[var(--brand-700)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'}`
  const nav = (
    <nav aria-label={`Project ${projectKey}`} className="space-y-5">
      <div className="flex items-center gap-2 px-3">
        <ProjectAvatar projectKey={projectKey} name={project.data?.name ?? projectKey} src={project.data?.avatarUrls?.['48x48'] ?? null} size={28} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[var(--text-primary)]">{project.data?.name ?? projectKey}</p><p className="text-[11px] text-[var(--text-tertiary)]">{projectKey}</p></div>
        <button type="button" onClick={toggle} aria-label="Collapse the project menu" title="Collapse the project menu" className="hidden lg:inline-flex p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><ChevronsLeft className="w-4 h-4" /></button>
      </div>
      <ul>
        {work.map((l) => <li key={l.id}><Link href={l.href} aria-current={isActiveProjectLink(l, pathname, tab) ? 'page' : undefined} className={cls(isActiveProjectLink(l, pathname, tab))}>{tr(l.label)}</Link></li>)}
      </ul>
      {settings.length > 0 && (
        <div>
          <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr('Project settings')}</p>
          {Array.from(new Set(settings.map((l) => l.group ?? ''))).map((group) => (
            <div key={group} className="mb-3 last:mb-0">
              {group && <p className="px-3 pt-1 pb-0.5 text-[11px] text-[var(--text-tertiary)]">{tr(group)}</p>}
              <ul>
                {settings.filter((l) => (l.group ?? '') === group).map((l) => <li key={l.id}><Link href={l.href} aria-current={isActiveProjectLink(l, pathname, tab) ? 'page' : undefined} className={cls(isActiveProjectLink(l, pathname, tab))}>{tr(l.label)}</Link></li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  )
  return (
    <>
      {collapsed ? (
        <aside className="hidden lg:flex flex-col items-center gap-2 w-9 shrink-0 self-start -mr-4 py-2 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] sticky top-[calc(var(--header-height,56px)+1.5rem)]">
          <button type="button" onClick={toggle} aria-label="Expand the project menu" title="Expand the project menu" className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><ChevronsRight className="w-4 h-4" /></button>
          <button type="button" onClick={toggle} aria-label={`Show the ${project.data?.name ?? projectKey} menu`} title={`${project.data?.name ?? projectKey}: show the project menu`} className="rounded-md hover:bg-[var(--surface-2)] p-0.5">
            <ProjectAvatar projectKey={projectKey} name={project.data?.name ?? projectKey} src={project.data?.avatarUrls?.['48x48'] ?? null} size={24} />
          </button>
        </aside>
      ) : (
        <aside className="hidden lg:block w-56 shrink-0 self-start sticky top-[calc(var(--header-height,56px)+1.5rem)] max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">{nav}</aside>
      )}
      <details className="lg:hidden mb-4 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-3">
        <summary className="cursor-pointer text-sm font-medium">{project.data?.name ?? projectKey} menu</summary>
        <div className="mt-3">{nav}</div>
      </details>
    </>
  )
}
