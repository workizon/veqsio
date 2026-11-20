/**
 * Command palette logic: items, grouping, ranking, recents and keyboard stepping. Pure and DOM free.
 * The component (components/command-palette.tsx) only renders what this returns.
 */
import { fuzzyMatch } from './fuzzy'
import { identityTr, type Tr } from './tr'
import { allPages } from './routes'
import { ADMIN_KEYWORDS } from './admin-helper'
import type { StorageLike } from './issue-nav'

export type PaletteGroup = 'recent' | 'issues' | 'projects' | 'boards' | 'pages' | 'actions' | 'people'

export const GROUP_ORDER: PaletteGroup[] = ['recent', 'issues', 'projects', 'boards', 'pages', 'actions', 'people']

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  recent: 'Recent',
  issues: 'Issues',
  projects: 'Projects',
  boards: 'Boards',
  pages: 'Pages',
  actions: 'Actions',
  people: 'People',
}

export type ActionId = 'create' | 'assignToMe' | 'myIssues' | 'toggleTheme' | 'help' | 'signOut'

export interface PaletteItem {
  /** Stable id, also the dedupe key: `issue:KEY`, `project:KEY`, `board:ID`, `page:/href`, `action:id`, `user:ID`. */
  id: string
  group: PaletteGroup
  title: string
  subtitle?: string
  href?: string
  action?: ActionId
  /** Shortcut spec (see lib/shortcuts) shown as a hint on the right. */
  shortcut?: string
  /** Extra words that should match but are not shown. */
  keywords?: string
  /** Small right-aligned text, e.g. the status of an issue. */
  badge?: string
}

export interface RankedItem {
  item: PaletteItem
  score: number
  titleRanges: Array<[number, number]>
  subtitleRanges: Array<[number, number]>
}

export interface RankedGroup { group: PaletteGroup; label: string; items: RankedItem[] }

/* ------------------------------------------------------------------ */
/*  Item sources                                                       */
/* ------------------------------------------------------------------ */

export const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

export function looksLikeIssueKey(q: string): boolean {
  return ISSUE_KEY_RE.test(q.trim())
}

export function issueItem(key: string, summary?: string, status?: string): PaletteItem {
  return { id: `issue:${key}`, group: 'issues', title: summary || key, subtitle: key, href: `/issues/${key}`, badge: status }
}

export function keyJumpItem(query: string, tr: Tr = identityTr): PaletteItem | null {
  const q = query.trim()
  if (!looksLikeIssueKey(q)) return null
  const key = q.toUpperCase()
  return { id: `issue:${key}`, group: 'issues', title: tr('Go to {key}', { key }), subtitle: key, href: `/issues/${key}` }
}

export function projectItem(p: { key: string; name: string }): PaletteItem {
  return { id: `project:${p.key}`, group: 'projects', title: p.name, subtitle: p.key, href: `/projects/${p.key}/settings`, keywords: 'project' }
}

export function boardItem(b: { id: string | number; name: string; type?: string }, tr: Tr = identityTr): PaletteItem {
  return { id: `board:${b.id}`, group: 'boards', title: b.name, subtitle: b.type ? tr('{type} board', { type: b.type }) : tr('Board'), href: `/boards?board=${encodeURIComponent(String(b.id))}` }
}

/** A wiki page found by the server-side page search. */
export function pageResultItem(p: { id: number; title: string; projectKey: string | null }, tr: Tr = identityTr): PaletteItem {
  return { id: `page:/pages/${p.id}`, group: 'pages', title: p.title, subtitle: p.projectKey ?? tr('Workspace page'), href: `/pages/${p.id}` }
}

export function userItem(u: { id: number | string; displayName: string; email?: string }, tr: Tr = identityTr): PaletteItem {
  return {
    id: `user:${u.id}`,
    group: 'people',
    title: u.displayName,
    subtitle: u.email || tr('Issues assigned to this person'),
    href: `/issues?jql=${encodeURIComponent(`assignee = "${u.displayName.replace(/"/g, '')}"`)}`,
  }
}

export function pageItems(tr: Tr = identityTr): PaletteItem[] {
  return allPages()
    // "Create issue" is offered as an action (opens the dialog), not as a second page entry.
    .filter((p) => p.href !== '/issues/create')
    .map((p) => ({ id: `page:${p.href}`, group: 'pages' as const, title: tr(p.label), subtitle: p.section === p.label ? (p.hint ? tr(p.hint) : p.hint) : tr(p.section), href: p.href, keywords: [p.hint, ...(ADMIN_KEYWORDS[p.href] ?? [])].filter(Boolean).join(' ') || undefined }))
}

export interface ActionContext {
  /** Key of the issue being viewed, enables "Assign to me". */
  issueKey?: string | null
}

export function actionItems(ctx: ActionContext = {}, tr: Tr = identityTr): PaletteItem[] {
  const out: PaletteItem[] = [
    { id: 'action:create', group: 'actions', title: tr('Create issue'), action: 'create', shortcut: 'c', keywords: 'new add ticket' },
  ]
  if (ctx.issueKey) {
    out.push({ id: 'action:assignToMe', group: 'actions', title: tr('Assign {key} to me', { key: ctx.issueKey }), action: 'assignToMe', shortcut: 'i', keywords: 'assignee take' })
  }
  out.push(
    { id: 'action:myIssues', group: 'actions', title: tr('Go to my issues'), action: 'myIssues', keywords: 'assigned mine' },
    { id: 'action:toggleTheme', group: 'actions', title: tr('Toggle dark mode'), action: 'toggleTheme', keywords: 'theme light dark appearance' },
    { id: 'action:help', group: 'actions', title: tr('Open shortcut help'), action: 'help', shortcut: 'mod+/', keywords: 'keyboard keys hotkeys' },
    { id: 'action:signOut', group: 'actions', title: tr('Sign out'), action: 'signOut', keywords: 'logout log out' },
  )
  return out
}

/* ------------------------------------------------------------------ */
/*  Ranking                                                            */
/* ------------------------------------------------------------------ */

export interface RankInput {
  query: string
  /** Items available without a network round trip (pages, actions, projects, boards, recents). */
  local: PaletteItem[]
  /** Server results that arrived, already mapped to items. */
  remote?: PaletteItem[]
  recents?: PaletteItem[]
  /** Max rows per group while typing / with an empty query. */
  limit?: number
  emptyLimit?: number
  /** Translates the "Go to KEY" jump entry (default: English). */
  tr?: Tr
}

/** Recent items are remembered under their original group; this keeps them out of the way of fresh results. */
export function rankItem(query: string, item: PaletteItem): RankedItem | null {
  const q = query.trim()
  if (!q) return { item, score: 0, titleRanges: [], subtitleRanges: [] }
  // Scattered letters across a long text are noise: a match must be worth at least two points per typed character.
  const min = q.replace(/\s+/g, '').length * 2
  const keep = (r: ReturnType<typeof fuzzyMatch>) => (r && r.score >= min ? r : null)
  const t = keep(fuzzyMatch(q, item.title))
  const s = item.subtitle ? keep(fuzzyMatch(q, item.subtitle)) : null
  const k = item.keywords ? keep(fuzzyMatch(q, item.keywords)) : null
  if (!t && !s && !k) return null
  // The title is what people read; the key/subtitle counts almost as much (issue keys live there).
  const scores = [t ? t.score : -Infinity, s ? s.score * 0.9 : -Infinity, k ? k.score * 0.5 : -Infinity]
  return {
    item,
    score: Math.max(...scores),
    titleRanges: t ? t.ranges : [],
    subtitleRanges: s ? s.ranges : [],
  }
}

export function buildGroups(input: RankInput): RankedGroup[] {
  const q = input.query.trim()
  const limit = input.limit ?? 6
  const emptyLimit = input.emptyLimit ?? 6
  const recents = input.recents ?? []

  if (!q) {
    const groups: RankedGroup[] = []
    const rec = recents.slice(0, emptyLimit).map((item) => rankItem('', item)!)
    if (rec.length) groups.push({ group: 'recent', label: GROUP_LABELS.recent, items: rec })
    const recentIds = new Set(recents.slice(0, emptyLimit).map((r) => r.id))
    for (const g of ['actions', 'pages'] as PaletteGroup[]) {
      const items = input.local.filter((i) => i.group === g && !recentIds.has(i.id)).slice(0, emptyLimit).map((item) => rankItem('', item)!)
      if (items.length) groups.push({ group: g, label: GROUP_LABELS[g], items })
    }
    return groups
  }

  // De-duplicate by id: remote data wins over local (fresher summary), a key jump wins over both.
  const byId = new Map<string, PaletteItem>()
  for (const i of [...recents, ...input.local]) byId.set(i.id, i)
  for (const i of input.remote ?? []) byId.set(i.id, i)
  const jump = keyJumpItem(q, input.tr)

  const ranked = new Map<PaletteGroup, RankedItem[]>()
  for (const item of byId.values()) {
    if (jump && item.id === jump.id) continue
    const r = rankItem(q, item)
    if (!r) continue
    const list = ranked.get(item.group) ?? []
    list.push(r)
    ranked.set(item.group, list)
  }
  if (jump) {
    const list = ranked.get('issues') ?? []
    // Prefer the real issue (with a summary) when the server already found it, but always keep it on top.
    const real = byId.get(jump.id)
    const item = real && real.title !== real.subtitle ? { ...real, title: real.title, subtitle: jump.subtitle } : jump
    list.push({ item, score: Number.MAX_SAFE_INTEGER, titleRanges: [], subtitleRanges: [] })
    ranked.set('issues', list)
  }

  const groups: RankedGroup[] = []
  for (const g of GROUP_ORDER) {
    if (g === 'recent') continue
    const list = ranked.get(g)
    if (!list || list.length === 0) continue
    list.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    groups.push({ group: g, label: GROUP_LABELS[g], items: list.slice(0, limit) })
  }
  // Groups whose best hit is stronger come first, except issues stay on top for a key jump.
  groups.sort((a, b) => {
    const ja = a.items[0]?.score === Number.MAX_SAFE_INTEGER ? 1 : 0
    const jb = b.items[0]?.score === Number.MAX_SAFE_INTEGER ? 1 : 0
    if (ja !== jb) return jb - ja
    return 0
  })
  return groups
}

export function flatten(groups: RankedGroup[]): RankedItem[] {
  return groups.flatMap((g) => g.items)
}

/* ------------------------------------------------------------------ */
/*  Keyboard stepping                                                  */
/* ------------------------------------------------------------------ */

/** Wraps around at both ends. Returns -1 for an empty list. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta >= 0 ? 0 : length - 1
  return (current + delta + length) % length
}

/** Flat index of the first item of the next (dir 1) or previous (dir -1) group, wrapping around. */
export function cycleGroup(groups: RankedGroup[], current: number, dir: 1 | -1): number {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  if (total === 0) return -1
  const starts: number[] = []
  let acc = 0
  for (const g of groups) { starts.push(acc); acc += g.items.length }
  let gi = 0
  for (let i = 0; i < starts.length; i++) if (current >= starts[i]) gi = i
  const ni = (gi + dir + groups.length) % groups.length
  return starts[ni]
}

/** Position helpers for rendering: which flat index belongs to the item at (group, row). */
export function flatIndexOf(groups: RankedGroup[], gi: number, row: number): number {
  let n = 0
  for (let i = 0; i < gi; i++) n += groups[i].items.length
  return n + row
}

/* ------------------------------------------------------------------ */
/*  Recents                                                            */
/* ------------------------------------------------------------------ */

export const RECENTS_KEY = 'veqsio-palette-recent'
export const MAX_RECENTS = 8

/** Only navigable items are remembered (an action has nothing to go back to). */
export function pushRecent(list: PaletteItem[], item: PaletteItem, max = MAX_RECENTS): PaletteItem[] {
  if (!item.href) return list
  // Remember the original group so a recent issue is still ranked as an issue when searching.
  const entry: PaletteItem = { id: item.id, group: item.group === 'recent' ? 'issues' : item.group, title: item.title, subtitle: item.subtitle, href: item.href, keywords: item.keywords, badge: item.badge }
  return [entry, ...list.filter((i) => i.id !== item.id)].slice(0, max)
}

export function loadRecents(storage: StorageLike | null | undefined): PaletteItem[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(RECENTS_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
      .filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.href === 'string' && GROUP_ORDER.includes(i.group))
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

export function saveRecents(storage: StorageLike | null | undefined, list: PaletteItem[]): boolean {
  if (!storage) return false
  try {
    storage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)))
    return true
  } catch {
    return false
  }
}

export function browserLocalStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Escapes a user query for a double-quoted JQL string. */
export function jqlQuote(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function searchJql(q: string): string {
  const t = jqlQuote(q.trim())
  return looksLikeIssueKey(q) ? `key = "${t.toUpperCase()}" OR text ~ "${t}"` : `text ~ "${t}"`
}
