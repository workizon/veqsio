/**
 * Pure roadmap/timeline computation. Inputs are plain data so everything is unit-testable without a database.
 */
import type { Category } from './agile'
import { dependencyConflict, type DependencyConflict } from '../issues/dependencies'

const DAY = 86_400_000

export interface RoadmapIssue {
  id: number
  key: string
  summary: string
  issueType: string
  category: Category
  createdAt: number
  /** Explicit start date (issues.start_date). */
  startDate: number | null
  dueDate: number | null
  parentId: number | null
  isEpic: boolean
  isSubtask: boolean
  /** Story points; null = unestimated (counts as 0). */
  storyPoints: number | null
  /** Time of the first transition into an in-progress status (from history). */
  firstInProgressAt: number | null
  /** Ids of the issue's fix versions. */
  fixVersionIds: number[]
}

export interface RoadmapVersion {
  id: number
  name: string
  /** yyyy-mm-dd */
  startDate: string | null
  releaseDate: string | null
  released: boolean
}

/**
 * `fromId` (predecessor) must come before `toId`: it blocks it ("Blocks"), starts before it or finishes before it
 * (dependency link types, see issues/dependencies.ts). `kind` defaults to 'blocks'.
 */
export type RoadmapLinkKind = 'blocks' | 'starts_before' | 'finishes_before'
export interface RoadmapLink { fromId: number; toId: number; kind?: RoadmapLinkKind }
export interface RoadmapDependency { from: string; to: string; kind: RoadmapLinkKind; conflict: boolean; message: string | null }

export type StartSource = 'explicit' | 'transition' | 'created'
export type EndSource = 'due' | 'children' | 'version' | 'none'

export interface RoadmapProgress {
  children: { done: number; total: number }
  points: { done: number; total: number }
  /** 0..100, by points when any child is estimated, otherwise by child count. */
  percent: number
}

export interface RoadmapItem {
  key: string
  summary: string
  issueType: string
  category: Category
  isEpic: boolean
  start: string
  startSource: StartSource
  /** null when nothing determines an end (no due date, no dated children, no dated fix version). */
  end: string | null
  endSource: EndSource
  explicitStart: string | null
  dueDate: string | null
  progress: RoadmapProgress
}

export interface RoadmapMilestone {
  id: number
  name: string
  startDate: string | null
  releaseDate: string | null
  released: boolean
}

export interface Roadmap {
  items: RoadmapItem[]
  versions: RoadmapMilestone[]
  dependencies: RoadmapDependency[]
}

const iso = (t: number) => new Date(t).toISOString()
const dayStr = (s: string) => Date.parse(`${s}T00:00:00.000Z`)

export function parseWindowDate(v: string | undefined | null): number | null {
  if (!v) return null
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayStr(v) : Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** Start: explicit start date, else first in-progress transition, else creation time. */
export function resolveStart(i: RoadmapIssue): { at: number; source: StartSource } {
  if (i.startDate !== null) return { at: i.startDate, source: 'explicit' }
  if (i.firstInProgressAt !== null) return { at: i.firstInProgressAt, source: 'transition' }
  return { at: i.createdAt, source: 'created' }
}

function progressOf(children: RoadmapIssue[]): RoadmapProgress {
  // Cancelled children are out of scope: they count neither as done nor in the total.
  children = children.filter((c) => c.category !== 'cancelled')
  const done = children.filter((c) => c.category === 'done')
  const pts = (list: RoadmapIssue[]) => list.reduce((a, c) => a + (c.storyPoints ?? 0), 0)
  const total = children.length
  const pTotal = pts(children)
  const pDone = pts(done)
  const percent = pTotal > 0 ? Math.round((pDone / pTotal) * 100) : total > 0 ? Math.round((done.length / total) * 100) : 0
  return { children: { done: done.length, total }, points: { done: pDone, total: pTotal }, percent }
}

export function buildRoadmap(args: {
  issues: RoadmapIssue[]
  versions: RoadmapVersion[]
  links: RoadmapLink[]
  /** Window (epoch ms); items not overlapping it and milestones outside it are dropped. */
  from?: number | null
  to?: number | null
  includeOrphans?: boolean
}): Roadmap {
  const { issues, versions, links } = args
  const from = args.from ?? null
  const to = args.to ?? null
  const versionById = new Map(versions.map((v) => [v.id, v]))
  const childrenOf = new Map<number, RoadmapIssue[]>()
  for (const i of issues) {
    if (i.parentId !== null) {
      const list = childrenOf.get(i.parentId) ?? []
      list.push(i)
      childrenOf.set(i.parentId, list)
    }
  }
  const epicIds = new Set(issues.filter((i) => i.isEpic).map((i) => i.id))
  const candidates = issues.filter((i) =>
    i.isEpic || (args.includeOrphans && !i.isSubtask && (i.parentId === null || !epicIds.has(i.parentId))))

  const items: Array<RoadmapItem & { id: number; startAt: number; endAt: number }> = []
  for (const i of candidates) {
    const kids = childrenOf.get(i.id) ?? []
    const start = resolveStart(i)

    let endAt: number | null = null
    let endSource: EndSource = 'none'
    if (i.dueDate !== null) { endAt = i.dueDate; endSource = 'due' }
    else {
      const kidDue = kids.map((k) => k.dueDate).filter((d): d is number => d !== null)
      if (kidDue.length) { endAt = Math.max(...kidDue); endSource = 'children' }
      else {
        const releases = i.fixVersionIds.map((id) => versionById.get(id)?.releaseDate).filter((d): d is string => !!d).map(dayStr)
        if (releases.length) { endAt = Math.max(...releases); endSource = 'version' }
      }
    }
    // An end before the start would render as a negative bar; clamp to a one-point bar.
    const endClamped = endAt === null ? null : Math.max(endAt, start.at)

    const overlapEnd = endClamped ?? start.at
    if (from !== null && overlapEnd < from) continue
    if (to !== null && start.at > to + DAY - 1) continue

    items.push({
      id: i.id, key: i.key, summary: i.summary, issueType: i.issueType, category: i.category, isEpic: i.isEpic,
      start: iso(start.at), startSource: start.source,
      end: endClamped === null ? null : iso(endClamped), endSource,
      explicitStart: i.startDate === null ? null : iso(i.startDate),
      dueDate: i.dueDate === null ? null : iso(i.dueDate),
      progress: progressOf(kids),
      startAt: start.at, endAt: overlapEnd,
    })
  }
  items.sort((a, b) => a.startAt - b.startAt || a.key.localeCompare(b.key, undefined, { numeric: true }))

  // Dependencies: "Blocks" links whose endpoints are roadmap items, or children of roadmap items (lifted to the parent).
  const itemById = new Map(items.map((x) => [x.id, x]))
  const issueById = new Map(issues.map((i) => [i.id, i]))
  const lift = (id: number): number | null => {
    if (itemById.has(id)) return id
    const parent = issueById.get(id)?.parentId
    return parent !== null && parent !== undefined && itemById.has(parent) ? parent : null
  }
  const seen = new Set<string>()
  const dependencies: Roadmap['dependencies'] = []
  for (const l of links) {
    const f = lift(l.fromId)
    const t = lift(l.toId)
    if (f === null || t === null || f === t) continue
    const fromKey = itemById.get(f)!.key
    const toKey = itemById.get(t)!.key
    const kind = l.kind ?? 'blocks'
    const sig = `${fromKey}>${toKey}>${kind}`
    if (seen.has(sig)) continue
    seen.add(sig)
    let conflict: DependencyConflict = { conflict: false, message: null }
    if (kind !== 'blocks') {
      const a = itemById.get(f)!
      const b = itemById.get(t)!
      conflict = dependencyConflict(kind, { start: Date.parse(a.start), end: a.end === null ? null : Date.parse(a.end) }, { start: Date.parse(b.start), end: b.end === null ? null : Date.parse(b.end) })
    }
    dependencies.push({ from: fromKey, to: toKey, kind, conflict: conflict.conflict, message: conflict.message })
  }
  dependencies.sort((a, b) => `${a.from}>${a.to}>${a.kind}`.localeCompare(`${b.from}>${b.to}>${b.kind}`, undefined, { numeric: true }))

  const milestones: RoadmapMilestone[] = versions
    .filter((v) => {
      const pts = [v.startDate, v.releaseDate].filter((d): d is string => !!d).map(dayStr)
      if (pts.length === 0) return false // undated versions cannot be placed on a timeline
      const lo = Math.min(...pts)
      const hi = Math.max(...pts)
      if (from !== null && hi < from) return false
      if (to !== null && lo > to + DAY - 1) return false
      return true
    })
    .map((v) => ({ id: v.id, name: v.name, startDate: v.startDate, releaseDate: v.releaseDate, released: v.released }))
    .sort((a, b) => (a.releaseDate ?? a.startDate ?? '').localeCompare(b.releaseDate ?? b.startDate ?? '') || a.id - b.id)

  return {
    items: items.map(({ id: _id, startAt: _s, endAt: _e, ...rest }) => rest),
    versions: milestones,
    dependencies,
  }
}

/** Validate a reschedule request. Dates are yyyy-mm-dd or null; start must not be after due. */
export function validateDates(start: string | null | undefined, due: string | null | undefined): string | null {
  const check = (v: string | null | undefined, label: string) => {
    if (v === null || v === undefined) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${label} must be yyyy-mm-dd`
    const t = dayStr(v)
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return `${label} is not a valid date`
    const y = new Date(t).getUTCFullYear()
    if (y < 1990 || y > 2100) return `${label} must be between 1990 and 2100`
    return null
  }
  const err = check(start, 'startDate') ?? check(due, 'dueDate')
  if (err) return err
  if (start && due && dayStr(start) > dayStr(due)) return 'startDate must not be after dueDate'
  return null
}
