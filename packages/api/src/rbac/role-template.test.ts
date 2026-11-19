import { describe, test, expect } from 'bun:test'
import { ROLE_TEMPLATE, roleTemplateEntries } from './role-template'
import { PROJECT_PERMISSIONS } from './types'

describe('role-based permission template', () => {
  test('only known project permissions, no duplicates per role', () => {
    const known = new Set<string>(PROJECT_PERMISSIONS)
    for (const [role, def] of Object.entries(ROLE_TEMPLATE)) {
      expect(def.permissions.filter((p) => !known.has(p))).toEqual([])
      expect(new Set(def.permissions).size).toBe(def.permissions.length)
      expect(def.permissions).toContain('BROWSE_PROJECTS')
      expect(role.length).toBeGreaterThan(0)
    }
  })
  test('a Commenter can comment but not create or edit; a Viewer cannot comment', () => {
    expect(ROLE_TEMPLATE.Commenters.permissions).toContain('ADD_COMMENTS')
    expect(ROLE_TEMPLATE.Commenters.permissions).not.toContain('CREATE_ISSUES')
    expect(ROLE_TEMPLATE.Commenters.permissions).not.toContain('EDIT_ISSUES')
    expect(ROLE_TEMPLATE.Viewers.permissions).not.toContain('ADD_COMMENTS')
    expect(ROLE_TEMPLATE.Administrators.permissions).toContain('PROJECT_ADMIN')
    expect(ROLE_TEMPLATE.Developers.permissions).not.toContain('PROJECT_ADMIN')
  })
  test('entries cover every role', () => {
    expect(new Set(roleTemplateEntries().map((e) => e.roleName))).toEqual(new Set(Object.keys(ROLE_TEMPLATE)))
  })
})
