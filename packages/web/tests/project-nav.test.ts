import { describe, expect, it } from 'bun:test'
import { canAdministerProject, isActiveProjectLink, projectKeyFromPath, resolveProjectContext, projectSettingsLinks, projectWorkLinks } from '../lib/project-nav'

describe('project navigation', () => {
  it('finds the project in the path, but not on the project list', () => {
    expect(projectKeyFromPath('/projects/DEMO')).toBe('DEMO')
    expect(projectKeyFromPath('/projects/DEMO/settings')).toBe('DEMO')
    expect(projectKeyFromPath('/projects/DEMO/releases')).toBe('DEMO')
    expect(projectKeyFromPath('/projects')).toBeNull()
    expect(projectKeyFromPath('/projectsX/DEMO')).toBeNull()
    // an issue page belongs to the project in its key
    expect(projectKeyFromPath('/issues/DEMO-1')).toBe('DEMO')
    expect(projectKeyFromPath('/issues/create')).toBeNull()
    expect(projectKeyFromPath('/issues')).toBeNull()
  })
  it('settings links follow the feature switches', () => {
    const all = projectSettingsLinks('DEMO', () => true).map((l) => l.id)
    expect(all).toContain('webhooks')
    expect(all).toContain('intake')
    const none = projectSettingsLinks('DEMO', (f) => !f).map((l) => l.id)
    expect(none).not.toContain('webhooks')
    expect(none).not.toContain('chat')
    expect(none).not.toContain('intake')
    expect(none).toContain('details')
    expect(projectSettingsLinks('DEMO', () => true)[0].href).toBe('/projects/DEMO/settings?tab=details')
  })
  it('marks the current link: settings by tab (details by default), the rest by path', () => {
    const links = projectSettingsLinks('DEMO', () => true)
    const people = links.find((l) => l.id === 'people')!, details = links.find((l) => l.id === 'details')!
    expect(isActiveProjectLink(people, '/projects/DEMO/settings', 'people')).toBe(true)
    expect(isActiveProjectLink(details, '/projects/DEMO/settings', null)).toBe(true)
    expect(isActiveProjectLink(details, '/projects/DEMO/settings', 'people')).toBe(false)
    const overview = projectWorkLinks('DEMO')[0]
    expect(isActiveProjectLink(overview, '/projects/DEMO', null)).toBe(true)
    expect(isActiveProjectLink(overview, '/projects/DEMO/settings', null)).toBe(false)
  })
  it('project administrators and system administrators see the settings; everybody else does not', () => {
    expect(canAdministerProject({ PROJECT_ADMIN: { havePermission: true } })).toBe(true)
    expect(canAdministerProject({ ADMINISTER_PROJECTS: { havePermission: true } })).toBe(true)
    expect(canAdministerProject({ SYSTEM_ADMIN: { havePermission: true } })).toBe(true)
    expect(canAdministerProject({ BROWSE_PROJECTS: { havePermission: true } })).toBe(false)
    expect(canAdministerProject(undefined)).toBe(false)
  })
})

describe('resolveProjectContext', () => {
  it('uses the project in the path', () => {
    expect(resolveProjectContext('/projects/MOB', null)).toEqual({ key: 'MOB', remember: 'MOB' })
  })
  it('keeps the remembered project on the global project pages', () => {
    for (const p of ['/issues', '/boards', '/backlog', '/roadmap', '/reports']) {
      expect(resolveProjectContext(p, 'MOB').key).toBe('MOB')
    }
  })
  it('forgets it elsewhere, and shows nothing without a remembered project', () => {
    expect(resolveProjectContext('/dashboard', 'MOB')).toEqual({ key: null, remember: null })
    expect(resolveProjectContext('/boards', null).key).toBeNull()
  })
})
