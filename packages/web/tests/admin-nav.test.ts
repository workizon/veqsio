import { describe, test, expect } from 'bun:test'
import { adminSections, isActiveAdminLink } from '../lib/admin-nav'
import { ADMIN_LINKS, ADMIN_SETTINGS } from '../lib/routes'

describe('admin navigation', () => {
  test('every known administration link is placed in a section (nothing falls into More)', () => {
    const sections = adminSections()
    const loose = sections.find((s) => s.id === 'more')
    const missing = [...ADMIN_LINKS, ...ADMIN_SETTINGS].filter((l) => l.href !== '/settings').map((l) => l.href).filter((h) => loose?.items.some((i) => i.href === h))
    expect(missing).toEqual([])
  })
  test('unknown pages and module pages land in More, once', () => {
    const s = adminSections([{ label: 'Timesheets', href: '/m/timesheets/admin' }, { label: 'Timesheets', href: '/m/timesheets/admin' }])
    expect(s.at(-1)!.id).toBe('more')
    expect(s.at(-1)!.items.filter((i) => i.href === '/m/timesheets/admin').length).toBe(1)
  })
  test('no href appears in two sections', () => {
    const all = adminSections().flatMap((s) => s.items.map((i) => i.href))
    expect(new Set(all).size).toBe(all.length)
  })
  test('active link detection uses the tab query for /admin entries', () => {
    expect(isActiveAdminLink('/admin?tab=users', '/admin', 'users')).toBe(true)
    expect(isActiveAdminLink('/admin?tab=users', '/admin', 'groups')).toBe(false)
    expect(isActiveAdminLink('/admin/audit', '/admin/audit', null)).toBe(true)
    expect(isActiveAdminLink('/admin/sso', '/admin/ssox', null)).toBe(false)
  })
})
