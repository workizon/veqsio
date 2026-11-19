import { describe, test, expect } from 'bun:test'
import {
  adminEntries, frequentEntries, loadUsage, recentEntries, recordUsage, saveUsage, scoreEntry, searchAdmin, tokenize, ADMIN_KEYWORDS, ADMIN_USAGE_KEY,
} from '../lib/admin-helper'
import { ADMIN_LINKS, ADMIN_SETTINGS, allPages } from '../lib/routes'
import type { StorageLike } from '../lib/issue-nav'

const top = (q: string) => searchAdmin(q)[0]?.entry.label

describe('tokenize', () => {
  test('drops filler and punctuation, keeps meaning words', () => {
    expect(tokenize("Why can't she see this issue?")).toEqual(['why', 'see', 'issue'])
    expect(tokenize('Add a custom field')).toEqual(['add', 'custom', 'field'])
  })
  test('stems simple plurals', () => {
    expect(tokenize('users')).toEqual(['user'])
    expect(tokenize('permission schemes')).toEqual(['permission', 'scheme'])
  })
})

describe('searchAdmin: intent and names', () => {
  test.each([
    ['add a custom field', 'Custom fields'],
    ['reset password', 'Users'],
    ["why can't she see this issue", 'Permission helper'],
    ['why did I not get an email', 'Notification helper'],
    ['permission scheme', 'Permission schemes'],
    ['audit log', 'Audit log'],
    ['smtp', 'System'],
    ['single sign on', 'Single sign-on'],
    ['make a field required', 'Field configurations'],
    ['create group', 'Groups'],
    ['workflow', 'Workflows'],
    ['import csv', 'CSV import'],
  ] as Array<[string, string]>)('%s -> %s', (query: string, label: string) => {
    expect(top(query)).toBe(label)
  })

  test('exact label beats a synonym hit elsewhere', () => {
    expect(top('Users')).toBe('Users')
    expect(top('groups')).toBe('Groups')
  })

  test('prefixes match while typing', () => {
    expect(top('custo')).toBe('Custom fields')
    expect(top('audi')).toBe('Audit log')
  })

  test('nothing for an empty or unrelated query', () => {
    expect(searchAdmin('')).toEqual([])
    expect(searchAdmin('   ')).toEqual([])
    expect(searchAdmin('zxqv')).toEqual([])
  })

  test('weak single-word hits are dropped when there is a clear winner', () => {
    const hits = searchAdmin("why can't she see this issue")
    expect(hits[0].entry.label).toBe('Permission helper')
    expect(hits.every((h) => h.score >= hits[0].score * 0.4)).toBe(true)
    expect(hits.length).toBeLessThan(6)
  })

  test('limit and ordering', () => {
    const hits = searchAdmin('field', undefined, 3)
    expect(hits.length).toBeLessThanOrEqual(3)
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
  })

  test('scoreEntry is 0 when no word matches', () => {
    const users = adminEntries().find((e) => e.label === 'Users')!
    expect(scoreEntry('kubernetes', users)).toBe(0)
    expect(scoreEntry('reset password', users)).toBeGreaterThan(scoreEntry('password', users) - 1)
  })
})

describe('catalog', () => {
  test('covers every admin link and tab setting exactly once', () => {
    const hrefs = adminEntries().map((e) => e.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const l of [...ADMIN_LINKS, ...ADMIN_SETTINGS]) expect(hrefs).toContain(l.href)
  })
  test('every synonym key points at a real page', () => {
    const hrefs = new Set(adminEntries().map((e) => e.href))
    for (const k of Object.keys(ADMIN_KEYWORDS)) expect(hrefs.has(k)).toBe(true)
  })
  test('the helper pages are in the admin menu and in the page registry', () => {
    expect(ADMIN_LINKS.map((l) => l.href)).toContain('/admin/permission-helper')
    expect(ADMIN_LINKS.map((l) => l.href)).toContain('/admin/notification-helper')
    expect(allPages().map((p) => p.href)).toContain('/admin?tab=custom-fields')
  })
})

describe('recent and frequent', () => {
  const mem = (): StorageLike & { data: Record<string, string> } => {
    const data: Record<string, string> = {}
    return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v }, removeItem: (k: string) => { delete data[k] } } as any
  }
  test('records, orders and persists usage', () => {
    let u = recordUsage([], '/admin/audit', 1)
    u = recordUsage(u, '/admin?tab=users', 2)
    u = recordUsage(u, '/admin/audit', 3)
    expect(recentEntries(u).map((e) => e.href)).toEqual(['/admin/audit', '/admin?tab=users'])
    expect(frequentEntries(u).map((e) => e.href)).toEqual(['/admin/audit'])
    const s = mem()
    saveUsage(s, u)
    expect(loadUsage(s)).toEqual(u)
    expect(s.data[ADMIN_USAGE_KEY]).toBeDefined()
  })
  test('survives broken or missing storage', () => {
    const s = mem()
    s.data[ADMIN_USAGE_KEY] = '{not json'
    expect(loadUsage(s)).toEqual([])
    expect(loadUsage(null)).toEqual([])
    expect(() => saveUsage({ getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} } as any, [])).not.toThrow()
  })
  test('unknown pages are ignored', () => {
    expect(recentEntries([{ href: '/gone', count: 3, last: 1 }])).toEqual([])
  })
})
