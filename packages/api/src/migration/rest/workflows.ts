import { eq } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import type { JiraClient } from './client'
import type { Resolver } from '../resolver'
import type { NormalizedIssue } from './mapper'

/**
 * Workflow migration for the REST importer.
 *
 * Two sources are combined:
 *  1. Real Jira workflows (Cloud: GET /rest/api/2/workflow/search), best-effort. A real workflow is used for a
 *     (project, issue type) group when it contains every status observed in that group.
 *  2. Inference from the imported issues: the status changelog items give the observed (from -> to) pairs,
 *     the first status of each issue and its current status. Only counters are kept (memory-bounded).
 */

export type Category = 'todo' | 'in_progress' | 'done'

export interface GroupObservation {
  subtask: boolean
  /** "from\0to" -> number of observed moves */
  pairs: Map<string, number>
  /** status the issue was created in -> count */
  first: Map<string, number>
  /** current status -> count */
  current: Map<string, number>
}

const SEP = '\u0000'
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

/** Collects (projectKey, issueType) group counters while issues stream by. */
export class WorkflowObservations {
  readonly groups = new Map<string, Map<string, GroupObservation>>()
  readonly categories = new Map<string, Category>()

  add(projectKey: string, issue: Pick<NormalizedIssue, 'issueType' | 'status' | 'history'>) {
    let byType = this.groups.get(projectKey)
    if (!byType) this.groups.set(projectKey, (byType = new Map()))
    let g = byType.get(issue.issueType.name)
    if (!g) byType.set(issue.issueType.name, (g = { subtask: issue.issueType.subtask, pairs: new Map(), first: new Map(), current: new Map() }))

    this.categories.set(issue.status.name, issue.status.category)
    bump(g.current, issue.status.name)
    const moves = issue.history
      .filter((h) => h.field === 'status' && h.from && h.to)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    for (const m of moves) bump(g.pairs, `${m.from}${SEP}${m.to}`)
    bump(g.first, moves.length ? moves[0].from! : issue.status.name)
  }
}

export interface PlannedTransition { name: string; from: string | null; to: string; screen?: string }
export interface WorkflowPlan {
  statuses: string[]
  initial: string
  transitions: PlannedTransition[]
  /** Name of the real Jira workflow the plan is based on, if any. */
  source: string | null
}

function mostCommon(m: Map<string, number>): string | undefined {
  let best: string | undefined
  let n = -1
  for (const [k, v] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) if (v > n) { best = k; n = v }
  return best
}

export function splitPair(k: string): [string, string] {
  const i = k.indexOf(SEP)
  return [k.slice(0, i), k.slice(i + 1)]
}

/** Pick a transition name unique within `taken` (lower-cased); `To X`, then `To X (from Y)`, then a counter. */
export function uniqueTransitionName(to: string, from: string | null, taken: Set<string>): string {
  const candidates = [`To ${to}`, `To ${to} (from ${from ?? 'start'})`]
  for (const c of candidates) if (!taken.has(c.toLowerCase())) { taken.add(c.toLowerCase()); return c.slice(0, 255) }
  for (let i = 2; ; i++) {
    const c = `To ${to} (from ${from ?? 'start'}) ${i}`
    if (!taken.has(c.toLowerCase())) { taken.add(c.toLowerCase()); return c.slice(0, 255) }
  }
}

/** Real Jira workflow reduced to names. */
export interface RealWorkflow {
  name: string
  statuses: Array<{ name: string; category?: Category }>
  /** `screen` is the id of the Jira screen the transition shows, when Jira says so. */
  transitions: Array<{ name: string; from: string | null; to: string; screen?: string }>
}

/** Normalise one entry of Jira Cloud's /workflow/search response. Returns null when it has no usable transitions. */
export function parseRealWorkflow(w: any): RealWorkflow | null {
  const name = String(w?.id?.name ?? w?.name ?? '').trim()
  if (!name || !Array.isArray(w?.transitions) || !Array.isArray(w?.statuses)) return null
  const byId = new Map<string, { name: string; category?: Category }>()
  for (const s of w.statuses) {
    if (s?.id == null || !s.name) continue
    const key = s.statusCategory?.key ?? s.statusCategory
    byId.set(String(s.id), { name: String(s.name), category: key === 'done' ? 'done' : key === 'indeterminate' ? 'in_progress' : key === 'new' || key === 'todo' ? 'todo' : undefined })
  }
  const transitions: RealWorkflow['transitions'] = []
  for (const t of w.transitions) {
    const to = byId.get(String(t.to))?.name
    if (!to || !t.name) continue
    const screen = t.screen?.id !== undefined ? String(t.screen.id) : undefined
    if (t.type === 'initial') { transitions.push({ name: String(t.name), from: null, to, ...(screen ? { screen } : {}) }); continue }
    const froms: string[] = Array.isArray(t.from) && t.from.length
      ? t.from.map((f: any) => byId.get(String(f))?.name).filter((f: string | undefined): f is string => !!f)
      : [...byId.values()].map((s) => s.name).filter((n) => n !== to) // global transition: reachable from every status
    for (const f of froms) transitions.push({ name: String(t.name), from: f, to, ...(screen ? { screen } : {}) })
  }
  if (!transitions.length) return null
  return { name, statuses: [...byId.values()], transitions }
}

export function observedStatuses(g: GroupObservation): string[] {
  const s = new Set<string>()
  for (const k of g.pairs.keys()) { const [a, b] = splitPair(k); s.add(a); s.add(b) }
  for (const k of g.first.keys()) s.add(k)
  for (const k of g.current.keys()) s.add(k)
  return [...s].sort((a, b) => a.localeCompare(b))
}

/** Choose the real workflow that contains all observed statuses and matches most observed transitions. */
export function pickRealWorkflow(g: GroupObservation, candidates: RealWorkflow[]): RealWorkflow | null {
  const need = observedStatuses(g).map((s) => s.toLowerCase())
  const observed = new Set([...g.pairs.keys()].map((k) => splitPair(k).map((x) => x.toLowerCase()).join(SEP)))
  let best: { w: RealWorkflow; score: number } | null = null
  for (const w of candidates) {
    const have = new Set(w.statuses.map((s) => s.name.toLowerCase()))
    if (!need.every((s) => have.has(s))) continue
    const matched = w.transitions.filter((t) => t.from && observed.has(`${t.from.toLowerCase()}${SEP}${t.to.toLowerCase()}`)).length
    // more matched transitions first, then smaller workflow, then name for determinism
    const score = matched * 1000 - w.statuses.length
    if (!best || score > best.score || (score === best.score && w.name < best.w.name)) best = { w, score }
  }
  return best?.w ?? null
}

/**
 * Build the workflow for one group. Pure.
 *
 * Without a real workflow the transitions are the observed (from -> to) pairs named `To <status>`, plus an initial
 * transition (from NULL) to the most common first status. Because history only reveals the moves people actually made,
 * the observed graph frequently contains terminal statuses (e.g. Done) with no way out although Jira workflows
 * almost always allow reopening. If any terminal status exists we therefore connect every status with every other
 * one, so no imported issue is stuck. A real Jira workflow is trusted as is (its transitions keep their names)
 * and only gets the observed pairs it lacks.
 */
export function inferWorkflow(g: GroupObservation, real: RealWorkflow | null): WorkflowPlan {
  const statuses = new Set(observedStatuses(g))
  const firstObserved = mostCommon(g.first) ?? mostCommon(g.current) ?? 'To Do'
  statuses.add(firstObserved)
  const taken = new Set<string>()
  const transitions: PlannedTransition[] = []
  const have = new Set<string>()
  const add = (name: string | null, from: string | null, to: string, screen?: string) => {
    const k = `${from ?? ''}${SEP}${to}`.toLowerCase()
    if (have.has(k)) return
    have.add(k)
    if (name && !taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); transitions.push({ name: name.slice(0, 255), from, to, ...(screen ? { screen } : {}) }) }
    else transitions.push({ name: uniqueTransitionName(to, from, taken), from, to, ...(screen ? { screen } : {}) })
  }

  let initial = firstObserved
  if (real) {
    const init = real.transitions.find((t) => t.from === null)
    if (init) initial = init.to
    for (const s of real.statuses) statuses.add(s.name)
    for (const t of real.transitions) add(t.name, t.from, t.to, t.screen)
  }
  add('Create', null, initial)
  statuses.add(initial)

  for (const k of [...g.pairs.keys()].sort()) { const [a, b] = splitPair(k); add(null, a, b) }

  if (!real) {
    const hasOut = new Set(transitions.filter((t) => t.from).map((t) => t.from!.toLowerCase()))
    const terminal = [...statuses].some((s) => !hasOut.has(s.toLowerCase()))
    if (terminal) {
      const all = [...statuses].sort((a, b) => a.localeCompare(b))
      for (const a of all) for (const b of all) if (a !== b) add(null, a, b)
    }
  }
  return { statuses: [...statuses].sort((a, b) => a.localeCompare(b)), initial, transitions, source: real?.name ?? null }
}

/** Best-effort: read real workflows. Never throws. */
export async function fetchRealWorkflows(client: JiraClient): Promise<RealWorkflow[]> {
  const out: RealWorkflow[] = []
  try {
    let startAt = 0
    for (let page = 0; page < 100; page++) {
      const r = await client.get('/rest/api/2/workflow/search', { expand: 'transitions,statuses', startAt, maxResults: 50 })
      const values: any[] = r?.values ?? []
      for (const v of values) { const w = parseRealWorkflow(v); if (w) out.push(w) }
      startAt += values.length
      if (!values.length || r?.isLast !== false) break
    }
  } catch { /* Server/DC or insufficient permission: fall back to inference */ }
  if (!out.length) {
    try {
      // Server/DC: usually only names (no transitions); parse anyway in case a version returns them.
      const r = await client.get('/rest/api/2/workflow')
      if (Array.isArray(r)) for (const v of r) { const w = parseRealWorkflow(v); if (w) out.push(w) }
    } catch { /* ignore */ }
  }
  return out
}

export interface WorkflowStats { workflows: number; transitions: number }

/** Persist plans for the given projects. Idempotent: reuse by name, add only missing transitions. */
export async function importWorkflows(
  client: JiraClient, resolver: Resolver, obs: WorkflowObservations,
  projects: Array<{ key: string; id: number }>, warnings: string[], cache: { real?: RealWorkflow[] } = {},
  /** Jira screen id to the screen here, from the screens import: a transition that shows a screen in Jira shows it here. */
  screenByJiraId: Map<string, number> = new Map(),
): Promise<Map<string, WorkflowStats>> {
  const stats = new Map<string, WorkflowStats>()
  const withData = projects.filter((p) => obs.groups.has(p.key))
  if (!withData.length) return stats
  const firstLookup = cache.real === undefined
  const real = (cache.real ??= await fetchRealWorkflows(client))
  if (firstLookup && !real.length) warnings.push('Real Jira workflows could not be read (needs Jira Cloud or admin rights); workflows were inferred from issue history.')

  for (const p of withData) {
    const stat: WorkflowStats = { workflows: 0, transitions: 0 }
    stats.set(p.key, stat)
    const itemsWanted: Array<{ issueTypeId: number; workflowId: number }> = []

    for (const [typeName, g] of [...obs.groups.get(p.key)!.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const plan = inferWorkflow(g, pickRealWorkflow(g, real))
      const wfName = `${p.key} ${typeName} workflow (imported)`.slice(0, 255)
      let [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.name, wfName)).limit(1)
      if (!wf) {
        ;[wf] = await db.insert(schema.workflows).values({
          name: wfName, isDefault: false,
          description: plan.source ? `Imported from Jira workflow "${plan.source}"` : 'Inferred from the status history of imported issues',
        }).returning()
        stat.workflows++
      }

      const statusId = new Map<string, number>()
      for (const s of plan.statuses) statusId.set(s, await resolver.status(s, obs.categories.get(s) ?? 'in_progress'))

      const existing = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, wf.id))
      const keyOf = (from: number | null, to: number) => `${from ?? ''}:${to}`
      const haveKeys = new Set(existing.map((t) => keyOf(t.fromStatusId, t.toStatusId)))
      const taken = new Set(existing.map((t) => t.name.toLowerCase()))
      const hasInitial = existing.some((t) => t.fromStatusId === null)

      for (const t of plan.transitions) {
        if (t.from === null && hasInitial) continue
        const from = t.from === null ? null : statusId.get(t.from)!
        const to = statusId.get(t.to)!
        if (haveKeys.has(keyOf(from, to))) continue
        haveKeys.add(keyOf(from, to))
        const name = taken.has(t.name.toLowerCase()) ? uniqueTransitionName(t.to, t.from, taken) : (taken.add(t.name.toLowerCase()), t.name)
        const screenId = t.screen ? screenByJiraId.get(t.screen) : undefined
        await db.insert(schema.workflowTransitions).values({ workflowId: wf.id, name, fromStatusId: from, toStatusId: to, ...(screenId !== undefined ? { screenId } : {}) })
        stat.transitions++
      }
      itemsWanted.push({ issueTypeId: await resolver.issueType(typeName, g.subtask), workflowId: wf.id })
    }

    // Scheme + association (never override an administrator's configuration).
    const schemeName = `${p.key} workflow scheme (imported)`
    let [scheme] = await db.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.name, schemeName)).limit(1)
    if (!scheme) [scheme] = await db.insert(schema.workflowSchemes).values({ name: schemeName, description: `Created by the Jira REST import for ${p.key}` }).returning()
    for (const it of itemsWanted) {
      await db.insert(schema.workflowSchemeItems).values({ schemeId: scheme.id, ...it }).onConflictDoNothing()
    }
    const [assoc] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, p.id)).limit(1)
    if (!assoc) {
      await db.insert(schema.workflowSchemeAssociations).values({ projectId: p.id, schemeId: scheme.id })
    } else if (assoc.schemeId !== scheme.id) {
      warnings.push(`${p.key}: project already uses a workflow scheme; the imported scheme "${schemeName}" was created but not assigned (assign it in project settings if wanted)`)
    }
  }
  return stats
}
