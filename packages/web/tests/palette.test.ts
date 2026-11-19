import { describe, test, expect } from 'bun:test'
import {
  actionItems, boardItem, buildGroups, cycleGroup, flatten, issueItem, jqlQuote, keyJumpItem, loadRecents, looksLikeIssueKey,
  pageItems, projectItem, pushRecent, saveRecents, searchJql, stepIndex, userItem, RECENTS_KEY, type PaletteItem,
} from '../lib/palette'
import { allPages, ADMIN_LINKS, NAV_GROUPS } from '../lib/routes'
import type { StorageLike } from '../lib/issue-nav'

const local = (): PaletteItem[] => [
  ...pageItems(),
  ...actionItems(),
  projectItem({ key: 'DEMO', name: 'Demo project' }),
  projectItem({ key: 'WEB', name: 'Website' }),
  boardItem({ id: 7, name: 'DEMO Scrum', type: 'scrum' }),
]

const ids = (g: ReturnType<typeof buildGroups>) => g.map((x) => [x.group, x.items.map((i) => i.item.id)])

describe('page table', () => {
  test('palette pages come from the shared route table', () => {
    const hrefs = pageItems().map((p) => p.href)
    for (const g of NAV_GROUPS) for (const l of g.items ?? []) if (l.href !== '/issues/create') expect(hrefs).toContain(l.href)
    for (const l of ADMIN_LINKS) expect(hrefs).toContain(l.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(allPages().length).toBeGreaterThan(15)
  })
})

describe('buildGroups', () => {
  test('empty query shows recents, actions and a few pages', () => {
    const recents = [issueItem('DEMO-1', 'First')]
    const groups = buildGroups({ query: '', local: local(), recents })
    expect(groups.map((g) => g.group)).toEqual(['recent', 'actions', 'pages'])
    expect(groups[0].items[0].item.id).toBe('issue:DEMO-1')
  })

  test('empty query without recents omits that group', () => {
    expect(buildGroups({ query: '', local: local() }).map((g) => g.group)).toEqual(['actions', 'pages'])
  })

  test('local results appear instantly in their groups with highlight ranges', () => {
    const groups = buildGroups({ query: 'dark', local: local() })
    expect(groups.map((g) => g.group)).toEqual(['actions'])
    const hit = groups[0].items[0]
    expect(hit.item.action).toBe('toggleTheme')
    expect(hit.titleRanges.length).toBeGreaterThan(0)
  })

  test('fuzzy matches pages, projects and boards', () => {
    const groups = buildGroups({ query: 'demo', local: local() })
    expect(groups.map((g) => g.group)).toEqual(['projects', 'boards'])
  })

  test('remote issues are merged and ranked', () => {
    const remote = [issueItem('DEMO-12', 'Login page crashes'), issueItem('DEMO-30', 'Unrelated login thing')]
    const groups = buildGroups({ query: 'login', local: local(), remote })
    const issues = groups.find((g) => g.group === 'issues')!
    expect(issues.items.length).toBe(2)
    expect(issues.items[0].titleRanges.length).toBeGreaterThan(0)
  })

  test('typing an issue key puts a jump item first even before the server answers', () => {
    const groups = buildGroups({ query: 'demo-12', local: local() })
    expect(groups[0].group).toBe('issues')
    expect(groups[0].items[0].item.href).toBe('/issues/DEMO-12')
    expect(groups[0].items[0].item.title).toBe('Go to DEMO-12')
  })

  test('a key jump keeps the real summary once the server found the issue', () => {
    const groups = buildGroups({ query: 'DEMO-12', local: local(), remote: [issueItem('DEMO-12', 'Login page crashes')] })
    const issues = groups[0].items
    expect(issues.filter((i) => i.item.id === 'issue:DEMO-12').length).toBe(1)
    expect(issues[0].item.title).toBe('Login page crashes')
  })

  test('remote beats a stale recent with the same id', () => {
    const groups = buildGroups({ query: 'login', local: [], recents: [issueItem('A-1', 'login old title')], remote: [issueItem('A-1', 'login new title')] })
    expect(groups[0].items.length).toBe(1)
    expect(groups[0].items[0].item.title).toBe('login new title')
  })

  test('a recent issue is still found by search while the server is loading', () => {
    const groups = buildGroups({ query: 'login', local: [], recents: [issueItem('A-1', 'Fix login')] })
    expect(ids(groups)).toEqual([['issues', ['issue:A-1']]])
  })

  test('nothing matches gives no groups', () => {
    expect(buildGroups({ query: 'qqqqzzzz', local: local() })).toEqual([])
  })

  test('per-group limit is respected', () => {
    const many = Array.from({ length: 20 }, (_, i) => issueItem(`A-${i}`, `bug number ${i}`))
    expect(buildGroups({ query: 'bug', local: [], remote: many, limit: 4 })[0].items.length).toBe(4)
  })

  test('assign to me only exists on an issue', () => {
    expect(actionItems().some((a) => a.action === 'assignToMe')).toBe(false)
    const withIssue = actionItems({ issueKey: 'DEMO-3' })
    expect(withIssue.find((a) => a.action === 'assignToMe')?.title).toBe('Assign DEMO-3 to me')
  })

  test('required actions exist', () => {
    const acts = actionItems({ issueKey: 'X-1' }).map((a) => a.action)
    for (const a of ['create', 'assignToMe', 'myIssues', 'toggleTheme', 'help', 'signOut']) expect(acts).toContain(a as any)
  })

  test('people link to an issue search by assignee', () => {
    const u = userItem({ id: 4, displayName: 'Ada "Lovelace"', email: 'ada@x.io' })
    expect(decodeURIComponent(u.href!)).toBe('/issues?jql=assignee = "Ada Lovelace"')
  })
})

describe('issue keys and JQL', () => {
  test('looksLikeIssueKey', () => {
    expect(looksLikeIssueKey('DEMO-12')).toBe(true)
    expect(looksLikeIssueKey(' demo-1 ')).toBe(true)
    expect(looksLikeIssueKey('demo')).toBe(false)
    expect(looksLikeIssueKey('demo-')).toBe(false)
    expect(looksLikeIssueKey('12-3')).toBe(false)
    expect(keyJumpItem('nope')).toBeNull()
  })

  test('jql quoting', () => {
    expect(jqlQuote('say "hi" \\ now')).toBe('say \\"hi\\" \\\\ now')
    expect(searchJql('login')).toBe('text ~ "login"')
    expect(searchJql('demo-4')).toBe('key = "DEMO-4" OR text ~ "demo-4"')
  })
})

describe('keyboard stepping', () => {
  test('stepIndex wraps', () => {
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })

  test('cycleGroup jumps to the first item of the next group and wraps', () => {
    const groups = buildGroups({ query: 'e', local: local(), limit: 3 })
    const flat = flatten(groups)
    expect(groups.length).toBeGreaterThan(2)
    const second = groups[0].items.length
    expect(cycleGroup(groups, 0, 1)).toBe(second)
    expect(cycleGroup(groups, 1, 1)).toBe(second)
    expect(cycleGroup(groups, 0, -1)).toBe(flat.length - groups[groups.length - 1].items.length)
    expect(cycleGroup([], 0, 1)).toBe(-1)
  })
})

describe('recents', () => {
  function memory(): StorageLike & { data: Record<string, string> } {
    const data: Record<string, string> = {}
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v } }
  }

  test('pushRecent puts the newest first, de-duplicates and caps', () => {
    let list: PaletteItem[] = []
    for (let i = 0; i < 12; i++) list = pushRecent(list, issueItem(`A-${i}`, `t${i}`))
    expect(list.length).toBe(8)
    expect(list[0].id).toBe('issue:A-11')
    list = pushRecent(list, issueItem('A-9', 't9'))
    expect(list[0].id).toBe('issue:A-9')
    expect(list.filter((i) => i.id === 'issue:A-9').length).toBe(1)
  })

  test('actions are not remembered', () => {
    expect(pushRecent([], actionItems()[0])).toEqual([])
  })

  test('save and load round trip, with the original group kept', () => {
    const s = memory()
    saveRecents(s, pushRecent([], projectItem({ key: 'WEB', name: 'Website' })))
    expect(loadRecents(s)[0]).toMatchObject({ id: 'project:WEB', group: 'projects', title: 'Website' })
  })

  test('survives broken storage and garbage', () => {
    const bad: StorageLike = { getItem() { throw new Error('no') }, setItem() { throw new Error('no') } }
    expect(loadRecents(bad)).toEqual([])
    expect(saveRecents(bad, [])).toBe(false)
    expect(loadRecents(null)).toEqual([])
    const s = memory()
    s.data[RECENTS_KEY] = '[{"id":1},{"id":"x","title":"t","href":"/","group":"bogus"},null]'
    expect(loadRecents(s)).toEqual([])
    s.data[RECENTS_KEY] = 'not json'
    expect(loadRecents(s)).toEqual([])
  })
})

describe('admin synonyms in the palette', () => {
  test('intent words find admin pages', () => {
    const pages = (q: string) => buildGroups({ query: q, local: local() }).find((g) => g.group === 'pages')?.items.map((i) => i.item.title) ?? []
    expect(pages('reset password')).toContain('Users')
    expect(pages('custom field')).toContain('Custom fields')
    expect(pages('permission helper')[0]).toBe('Permission helper')
  })
})
