import type { WebModuleDefinition } from '@veqsio/sdk'
import type { ActiveModuleWeb } from './module-registry'

export interface IssuePanelRef { moduleId: string; moduleName: string; key: string; title: string }

/** Issue view panels contributed by the active modules for one location, in module order. Pure. */
export function issuePanelsFor(active: ActiveModuleWeb[] | undefined, web: WebModuleDefinition[], location: 'sidebar' | 'content'): IssuePanelRef[] {
  const out: IssuePanelRef[] = []
  for (const m of active ?? []) {
    const impl = web.find((w) => w.id === m.id)?.issuePanels
    if (!impl) continue
    for (const p of m.web.issuePanels ?? []) {
      if (p.location === location && impl[p.key]) out.push({ moduleId: m.id, moduleName: m.name, key: p.key, title: p.title })
    }
  }
  return out
}

/** Module pages shown in the top navigation (pages with `hidden: true` are only reachable through links). */
export function topNavItems(active: ActiveModuleWeb[] | undefined): Array<{ moduleId: string; key: string; title: string; href: string }> {
  return (active ?? []).flatMap((m) => m.web.navItems.filter((n) => !n.hidden).map((n) => ({ moduleId: m.id, key: n.key, title: n.title, href: `/m/${m.id}/${n.path}` })))
}
