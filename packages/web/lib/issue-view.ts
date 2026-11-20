import { relativeIntl } from '@/lib/i18n'
/**
 * Pure helpers for the issue view (Jira-style layout). No React, no fetch: everything here is unit tested
 * in tests/issue-view.test.ts.
 */

/* ------------------------------------------------------------------ */
/*  Status categories and transitions                                  */
/* ------------------------------------------------------------------ */

export type StatusCategory = 'todo' | 'in_progress' | 'done'

/** The API (and old data) spells categories 'todo', 'to_do', 'new', 'indeterminate', 'in_progress', 'done'. */
export function normalizeCategory(category: string | null | undefined): StatusCategory {
  const c = (category || '').toLowerCase().replace(/[\s-]/g, '_')
  if (c === 'done' || c === 'complete' || c === 'completed' || c === 'cancelled' || c === 'canceled') return 'done' // cancelled is closed
  if (c === 'todo' || c === 'to_do' || c === 'new' || c === 'backlog' || c === '') return 'todo'
  return 'in_progress'
}

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
}

export interface TransitionLike {
  id: number
  name: string
  hasScreen?: boolean
  to: { id: number; name: string; statusCategory?: { key?: string; normalizedKey?: string } | string | null }
  requiresResolution?: boolean
  requiresComment?: boolean
  requiresInput?: boolean
  requiredFields?: string[]
  fields?: Record<string, { required?: boolean; schema?: { type?: string } }>
  /** Ordered fields of the transition's screen (rendered with the issue view editors). */
  screenFields?: Array<{ key: string; name: string; required: boolean }>
}

export function transitionCategory(t: TransitionLike): StatusCategory {
  const c = t.to.statusCategory
  if (!c) return 'todo'
  if (typeof c === 'string') return normalizeCategory(c)
  return normalizeCategory(c.normalizedKey || c.key)
}

/** Label shown in the dropdown: "Transition name -> Target status" (callers render the target as a lozenge). */
export function transitionLabel(t: TransitionLike): string {
  return t.name === t.to.name ? t.name : `${t.name} → ${t.to.name}`
}

/** Jira shows transitions in workflow order; we group them by target category so "Done" ones sit together. */
export function sortTransitions<T extends TransitionLike>(list: T[]): T[] {
  const order: Record<StatusCategory, number> = { todo: 0, in_progress: 1, done: 2 }
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => order[transitionCategory(a.t)] - order[transitionCategory(b.t)] || a.i - b.i)
    .map((x) => x.t)
}

/** Fields (other than the natively handled resolution/comment) that the dialog has to render as text inputs. */
export function extraRequiredFields(t: TransitionLike): string[] {
  const names = new Set<string>(t.requiredFields || [])
  for (const [name, def] of Object.entries(t.fields || {})) if (def?.required) names.add(name)
  names.delete('resolution')
  names.delete('comment')
  // Screen fields have their own editors in the dialog, they are not generic text inputs.
  for (const s of t.screenFields || []) names.delete(s.key)
  return [...names]
}

/** Whether selecting the transition must open the dialog instead of posting right away. */
export function transitionNeedsDialog(t: TransitionLike): boolean {
  if (t.requiresInput !== undefined) return t.requiresInput
  return !!t.hasScreen || !!t.requiresResolution || !!t.requiresComment || extraRequiredFields(t).length > 0
}

export interface TransitionFormState {
  resolutionId: string
  comment: string
  extra: Record<string, string>
}

/** Client-side check before posting; the server remains the authority and its messages are shown as well. */
export function validateTransitionForm(t: TransitionLike, form: TransitionFormState): string[] {
  const errors: string[] = []
  if ((t.requiresResolution || (t.requiredFields || []).includes('resolution')) && !form.resolutionId) {
    errors.push('Resolution is required')
  }
  if ((t.requiresComment || (t.requiredFields || []).includes('comment')) && !form.comment.trim()) {
    errors.push('Comment is required')
  }
  for (const f of extraRequiredFields(t)) {
    if (!(form.extra[f] || '').trim()) errors.push(`${f} is required`)
  }
  return errors
}

/** Builds the POST /transitions body (Jira shape: fields + update.comment). */
export function buildTransitionPayload(t: TransitionLike, form?: TransitionFormState) {
  const fields: Record<string, unknown> = {}
  if (form) {
    if (form.resolutionId) fields.resolution = { id: Number(form.resolutionId) }
    for (const [k, v] of Object.entries(form.extra)) if (v.trim()) fields[k] = v.trim()
    if (form.comment.trim()) fields.comment = form.comment.trim()
  }
  return { transitionId: t.id, fields }
}

/* ------------------------------------------------------------------ */
/*  Time tracking                                                      */
/* ------------------------------------------------------------------ */

const DAY = 8 * 3600
const WEEK = 5 * DAY

/** Jira-style duration (1w = 5d, 1d = 8h). `empty` is returned for null/0. */
export function formatSeconds(seconds: number | null | undefined, empty = 'None'): string {
  if (!seconds || seconds <= 0) return empty
  const weeks = Math.floor(seconds / WEEK)
  const days = Math.floor((seconds % WEEK) / DAY)
  const hours = Math.floor((seconds % DAY) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (weeks) parts.push(`${weeks}w`)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (mins) parts.push(`${mins}m`)
  return parts.join(' ') || '0m'
}

export interface TimeTracking {
  estimate: number | null
  spent: number
  remaining: number | null
  /** 0..100 share of the estimate that has been logged (100 when overrun). */
  spentPercent: number
  /** 0..100 share of the bar that is the remaining estimate. */
  remainingPercent: number
  overrun: boolean
  hasData: boolean
}

export function computeTimeTracking(estimate: number | null | undefined, spent: number | null | undefined): TimeTracking {
  const est = estimate && estimate > 0 ? estimate : null
  const sp = spent && spent > 0 ? spent : 0
  if (est === null) {
    return { estimate: null, spent: sp, remaining: null, spentPercent: sp > 0 ? 100 : 0, remainingPercent: 0, overrun: false, hasData: sp > 0 }
  }
  const remaining = Math.max(est - sp, 0)
  const spentPercent = Math.min(Math.round((sp / est) * 100), 100)
  return {
    estimate: est,
    spent: sp,
    remaining,
    spentPercent,
    remainingPercent: 100 - spentPercent,
    overrun: sp > est,
    hasData: true,
  }
}

/* ------------------------------------------------------------------ */
/*  Relative times                                                     */
/* ------------------------------------------------------------------ */

export function relativeTime(date: string | Date | null | undefined, now: Date = new Date()): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  const t = d.getTime()
  if (Number.isNaN(t)) return ''
  const diff = Math.round((now.getTime() - t) / 1000)
  const abs = Math.abs(diff)
  const suffix = (v: string) => (diff >= 0 ? `${v} ago` : `in ${v}`)
  const sign = diff >= 0 ? -1 : 1 // Intl: negative = past
  if (abs < 45) return relativeIntl(0, 'second') ?? 'just now'
  if (abs < 90) return relativeIntl(sign, 'minute') ?? suffix('1 minute')
  const minutes = Math.round(abs / 60)
  if (minutes < 45) return relativeIntl(sign * minutes, 'minute') ?? suffix(`${minutes} minutes`)
  const hours = Math.round(abs / 3600)
  if (hours < 22) return relativeIntl(sign * hours, 'hour') ?? suffix(hours === 1 ? '1 hour' : `${hours} hours`)
  const days = Math.round(abs / 86400)
  if (days < 26) return relativeIntl(sign * days, 'day') ?? suffix(days === 1 ? '1 day' : `${days} days`)
  const months = Math.round(abs / (86400 * 30))
  if (months < 11) return relativeIntl(sign * Math.max(1, months), 'month') ?? suffix(months <= 1 ? '1 month' : `${months} months`)
  const years = Math.round(abs / (86400 * 365))
  return relativeIntl(sign * Math.max(1, years), 'year') ?? suffix(years <= 1 ? '1 year' : `${years} years`)
}

/* ------------------------------------------------------------------ */
/*  Activity                                                           */
/* ------------------------------------------------------------------ */

export interface ActivityComment {
  id: string
  created: string
  parentId?: string | null
}
export interface ActivityHistory {
  id: string
  created: string
  items: Array<{ field: string }>
}

export type ActivityEntry<C, H> =
  | { type: 'comment'; date: number; key: string; comment: C }
  | { type: 'history'; date: number; key: string; history: H; itemIndex: number }

export type ActivityFilter = 'all' | 'comments' | 'history'

function ts(value: string): number {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Merges comments and history into one feed. Replies (comments whose thread root is another comment) are not
 * listed on their own; they are rendered under their root, so only top-level comments appear here.
 * Ties are broken by key so the order is stable between renders.
 */
export function mergeActivity<C extends ActivityComment, H extends ActivityHistory>(
  comments: C[],
  histories: H[],
  opts: { filter?: ActivityFilter; newestFirst?: boolean } = {},
): Array<ActivityEntry<C, H>> {
  const { filter = 'all', newestFirst = true } = opts
  const byId = new Map(comments.map((c) => [c.id, c]))
  const entries: Array<ActivityEntry<C, H>> = []
  if (filter !== 'history') {
    for (const c of comments) {
      if (c.parentId && byId.has(c.parentId) && c.parentId !== c.id) continue
      entries.push({ type: 'comment', date: ts(c.created), key: `comment-${c.id}`, comment: c })
    }
  }
  if (filter !== 'comments') {
    for (const h of histories) {
      ;(h.items || []).forEach((_, itemIndex) =>
        entries.push({ type: 'history', date: ts(h.created), key: `history-${h.id}-${itemIndex}`, history: h, itemIndex }),
      )
    }
  }
  entries.sort((a, b) => (a.date - b.date) || a.key.localeCompare(b.key))
  return newestFirst ? entries.reverse() : entries
}

/** Thread root of a comment (cycle safe) and replies grouped by root, oldest first. */
export function buildThreads<C extends ActivityComment>(comments: C[]) {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const rootOf = (c: C): string => {
    let cur = c
    const seen = new Set<string>()
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parentId)!
    }
    return cur.id
  }
  const repliesByRoot = new Map<string, C[]>()
  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      const r = rootOf(c)
      if (r !== c.id) repliesByRoot.set(r, [...(repliesByRoot.get(r) || []), c])
    }
  }
  for (const list of repliesByRoot.values()) list.sort((a, b) => ts(a.created) - ts(b.created))
  return { rootOf, repliesByRoot }
}

/* ------------------------------------------------------------------ */
/*  Links, sub-tasks, attachments                                      */
/* ------------------------------------------------------------------ */

export interface LinkLike {
  id: number
  type: { id: number; name: string; inward?: string; outward?: string }
  inwardIssue?: { id: number; key: string; summary: string }
  outwardIssue?: { id: number; key: string; summary: string }
}

export interface LinkGroup<L extends LinkLike = LinkLike> {
  label: string
  links: Array<{ link: L; issue: NonNullable<L['inwardIssue']> }>
}

/** Groups links by the sentence shown on this issue ("blocks", "is blocked by", ...), stable first-seen order. */
export function groupLinks<L extends LinkLike>(links: L[] | null | undefined): LinkGroup<L>[] {
  const groups = new Map<string, LinkGroup<L>>()
  for (const link of links || []) {
    const issue = link.inwardIssue || link.outwardIssue
    if (!issue) continue
    const label = (link.inwardIssue ? link.type.inward : link.type.outward) || link.type.name
    let g = groups.get(label)
    if (!g) {
      g = { label, links: [] }
      groups.set(label, g)
    }
    g.links.push({ link, issue: issue as NonNullable<L['inwardIssue']> })
  }
  return [...groups.values()]
}

/**
 * Which POST /issueLink arguments realise a chosen sentence. The API shows `type.inward` on the issue that is
 * `inwardIssue` in the request and `type.outward` on the other one, so "this issue blocks X" means X is inward.
 */
export function linkRequest(currentId: number, targetId: number, direction: 'inward' | 'outward') {
  return direction === 'outward'
    ? { inwardIssue: { id: targetId }, outwardIssue: { id: currentId } }
    : { inwardIssue: { id: currentId }, outwardIssue: { id: targetId } }
}

export interface SubtaskProgress {
  total: number
  done: number
  inProgress: number
  todo: number
  donePercent: number
  inProgressPercent: number
}

export function subtaskProgress(allItems: Array<{ category?: string | null }>): SubtaskProgress {
  // Cancelled sub-tasks are out of scope: they count neither as done nor in the total.
  const items = allItems.filter((i) => !/^cancel+ed$/i.test(i.category ?? ''))
  const total = items.length
  let done = 0
  let inProgress = 0
  for (const i of items) {
    const c = normalizeCategory(i.category)
    if (c === 'done') done++
    else if (c === 'in_progress') inProgress++
  }
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100))
  return { total, done, inProgress, todo: total - done - inProgress, donePercent: pct(done), inProgressPercent: pct(inProgress) }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function isImageAttachment(a: { mimeType?: string | null; filename?: string }): boolean {
  if (a.mimeType && a.mimeType.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(a.filename || '')
}

/** PDF preview is MIME-gated: a hostile file named .pdf must never be embedded as trusted content. */
export function isPdfAttachment(a: { mimeType?: string | null }): boolean {
  return a.mimeType?.toLowerCase() === 'application/pdf'
}

export function attachmentPreviewUrl(a: { id: string; mimeType?: string | null }): string | null {
  return isPdfAttachment(a) ? `/rest/api/2/attachment/${encodeURIComponent(a.id)}?inline=1` : null
}

/* ------------------------------------------------------------------ */
/*  Optimistic issue field patch                                       */
/* ------------------------------------------------------------------ */

/**
 * Applies the PUT body (`fields`) onto a cached issue for optimistic updates. Reference fields need display
 * data the PUT body does not carry, so callers pass `lookup` with the objects they already hold.
 */
export function patchIssueFields<T extends { fields: Record<string, any> }>(
  issue: T,
  patch: Record<string, any>,
  lookup: {
    users?: Array<{ id: number; displayName: string }>
    priorities?: Array<{ id: number | string; name: string; color?: string }>
    components?: Array<{ id: number; name: string }>
    versions?: Array<{ id: number; name: string }>
  } = {},
): T {
  const next: Record<string, any> = { ...issue.fields }
  const idOf = (v: any): number | null => (v === null || v === undefined ? null : typeof v === 'object' ? Number(v.id) : Number(v))
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'assignee': {
        const id = idOf(v)
        const u = id === null ? null : lookup.users?.find((x) => x.id === id)
        next.assignee = id === null ? null : u ? { id: u.id, displayName: u.displayName } : next.assignee
        break
      }
      case 'priority': {
        const id = idOf(v)
        const p = id === null ? null : lookup.priorities?.find((x) => Number(x.id) === id)
        next.priority = id === null ? null : p ? { id: Number(p.id), name: p.name, color: p.color } : next.priority
        break
      }
      case 'components': {
        const ids = (v as any[]).map(idOf)
        next.components = ids.map((id) => lookup.components?.find((c) => c.id === id) || (issue.fields.components || []).find((c: any) => c.id === id)).filter(Boolean)
        break
      }
      case 'fixVersions': {
        const ids = (v as any[]).map(idOf)
        next.fixVersions = ids.map((id) => lookup.versions?.find((c) => c.id === id) || (issue.fields.fixVersions || []).find((c: any) => c.id === id)).filter(Boolean)
        break
      }
      case 'parent':
      case 'security':
        break // needs a server round trip (key/summary, level name)
      default:
        next[k] = v
    }
  }
  return { ...issue, fields: next } as T
}
