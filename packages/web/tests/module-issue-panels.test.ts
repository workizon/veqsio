import { describe, test, expect } from 'bun:test'
import { issuePanelsFor, topNavItems } from '../lib/module-panels'
import type { ActiveModuleWeb } from '../lib/module-registry'

const Panel = () => null
const web = [{ id: 'itsm', issuePanels: { 'itsm-panel': Panel } }, { id: 'other', issuePanels: {} }, { id: 'nopanels' }] as never
const mod = (id: string, panels: Array<{ key: string; location: 'sidebar' | 'content' }>): ActiveModuleWeb => ({ id, name: id.toUpperCase(), feature: null, web: { navItems: [], adminPages: [], issuePanels: panels.map((p) => ({ ...p, title: p.key })) } })

describe('issuePanelsFor', () => {
  test('returns the panels of active modules for the location, only with an implementation', () => {
    const active = [mod('itsm', [{ key: 'itsm-panel', location: 'content' }]), mod('other', [{ key: 'ghost', location: 'content' }])]
    expect(issuePanelsFor(active, web, 'content').map((p) => `${p.moduleId}:${p.key}`)).toEqual(['itsm:itsm-panel'])
    expect(issuePanelsFor(active, web, 'sidebar')).toEqual([])
  })
  test('inactive modules (not in the active list) and a missing list render nothing', () => {
    expect(issuePanelsFor([], web, 'content')).toEqual([])
    expect(issuePanelsFor(undefined, web, 'content')).toEqual([])
  })
  test('a module without issuePanels in its manifest contributes nothing', () => {
    const m: ActiveModuleWeb = { id: 'itsm', name: 'ITSM', feature: null, web: { navItems: [], adminPages: [] } }
    expect(issuePanelsFor([m], web, 'content')).toEqual([])
  })
})

describe('topNavItems', () => {
  test('hidden pages are not in the top navigation but other pages are', () => {
    const m: ActiveModuleWeb = { id: 'itsm', name: 'ITSM', feature: null, web: { navItems: [{ key: 'incidents', title: 'ITSM', path: 'incidents' }, { key: 'problems', title: 'Problems', path: 'problems', hidden: true }], adminPages: [] } }
    expect(topNavItems([m])).toEqual([{ moduleId: 'itsm', key: 'incidents', title: 'ITSM', href: '/m/itsm/incidents' }])
    expect(topNavItems(undefined)).toEqual([])
  })
})
