/**
 * Pure helpers for the workflow designer canvas: layout, edge geometry,
 * client-side validation and item summaries. No React, no DOM, so everything
 * here is covered by unit tests.
 */

/** The five status groups. Backlog and Cancelled are optional: Backlog counts as to do and Cancelled as done-like (closed, but not completed work) wherever only three buckets exist. */
export type Category = 'backlog' | 'to_do' | 'in_progress' | 'done' | 'cancelled'
export const CATEGORY_ORDER: Category[] = ['backlog', 'to_do', 'in_progress', 'done', 'cancelled']
export const CATEGORY_HINT: Record<Category, string> = {
  backlog: 'Not planned yet. Counts as to do.',
  to_do: 'Planned, not started.',
  in_progress: 'Work has started.',
  done: 'Finished work. Needs a resolution.',
  cancelled: 'Will not be done. Needs a resolution, but is left out of velocity, burndown and progress.',
}

export interface DStatus { id: number; name: string; category: string; color?: string | null }
export interface DTransition { id: number; name: string; fromStatusId: number | null; toStatusId: number }
export interface Pos { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const NODE_H = 36
export const ANY_NODE_ID = 0

/** Statuses imported from Jira use 'todo'; the admin API uses 'to_do'. */
export function normalizeCategory(c: string | null | undefined): Category {
  if (c === 'done') return 'done'
  if (c === 'cancelled' || c === 'canceled') return 'cancelled'
  if (c === 'backlog') return 'backlog'
  if (c === 'in_progress') return 'in_progress'
  return 'to_do'
}

export const CATEGORY_LABEL: Record<Category, string> = { backlog: 'Backlog', to_do: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }

/** Theme variable per category, so dark mode follows the design system. */
export const CATEGORY_VAR: Record<Category, string> = {
  backlog: 'var(--status-backlog, #8993A4)',
  cancelled: 'var(--status-cancelled, #B42318)',
  to_do: 'var(--status-todo)',
  in_progress: 'var(--status-inprogress)',
  done: 'var(--status-done)',
}

export function nodeWidth(name: string): number {
  return Math.max(96, Math.min(220, Math.round(28 + name.length * 7.4)))
}

export function nodeRect(s: DStatus, p: Pos): Rect {
  return { x: p.x, y: p.y, w: nodeWidth(s.name), h: NODE_H }
}

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

export interface LayoutOptions { gapX?: number; gapY?: number; originX?: number; originY?: number }

/**
 * Layered left-to-right layout. Layer = shortest distance from an entry
 * status (no incoming transition and not the target of a global one). Cycles
 * are fine since distance is computed with BFS. Statuses that cannot be
 * reached from an entry are appended in later layers. Deterministic.
 */
export function autoLayout(statuses: DStatus[], transitions: DTransition[], opts: LayoutOptions = {}): Record<number, Pos> {
  const gapX = opts.gapX ?? 250
  const gapY = opts.gapY ?? 90
  const ox = opts.originX ?? 60
  const oy = opts.originY ?? 60
  const ids = statuses.map((s) => s.id)
  const idSet = new Set(ids)
  const out = new Map<number, number[]>()
  const hasIncoming = new Set<number>()
  const globalTargets = new Set<number>()
  for (const t of transitions) {
    if (!idSet.has(t.toStatusId)) continue
    if (t.fromStatusId === null) { globalTargets.add(t.toStatusId); continue }
    if (!idSet.has(t.fromStatusId)) continue
    if (!out.has(t.fromStatusId)) out.set(t.fromStatusId, [])
    out.get(t.fromStatusId)!.push(t.toStatusId)
    if (t.fromStatusId !== t.toStatusId) hasIncoming.add(t.toStatusId)
  }

  const layer = new Map<number, number>()
  const visit = (starts: number[], base: number) => {
    const queue: number[] = []
    for (const s of starts) if (!layer.has(s)) { layer.set(s, base); queue.push(s) }
    while (queue.length) {
      const cur = queue.shift()!
      for (const nx of out.get(cur) ?? []) {
        if (!layer.has(nx)) { layer.set(nx, layer.get(cur)! + 1); queue.push(nx) }
      }
    }
  }
  const entries = ids.filter((id) => !hasIncoming.has(id) && !globalTargets.has(id) && (out.get(id)?.length ?? 0) > 0)
  visit(entries, 0)
  // global targets: the status issues are sent to from "any", put them after the flow
  const flowDepth = layer.size ? Math.max(...layer.values()) : -1
  visit(ids.filter((id) => globalTargets.has(id)), flowDepth + 1)
  // anything left (pure cycles, isolated statuses)
  for (const id of ids) {
    if (layer.has(id)) continue
    const depth = layer.size ? Math.max(...layer.values()) : -1
    visit([id], layer.size && !hasIncoming.has(id) && !(out.get(id)?.length) ? depth + 1 : Math.max(0, depth + 1))
  }

  const byLayer = new Map<number, number[]>()
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(id)
  }
  const tallest = Math.max(1, ...[...byLayer.values()].map((v) => v.length))
  const result: Record<number, Pos> = {}
  for (const [l, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = ((tallest - members.length) * gapY) / 2
    members.forEach((id, i) => { result[id] = { x: ox + l * gapX, y: oy + offset + i * gapY } })
  }
  return result
}

/**
 * Keeps stored positions and places only statuses without one: all of them via
 * autoLayout when nothing is stored, otherwise in a row below the existing nodes.
 */
export function mergeLayout(statuses: DStatus[], transitions: DTransition[], stored: Record<string, Pos> | Record<number, Pos> | null | undefined): Record<number, Pos> {
  const have: Record<number, Pos> = {}
  for (const s of statuses) {
    const p = (stored as any)?.[s.id]
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) have[s.id] = { x: p.x, y: p.y }
  }
  const missing = statuses.filter((s) => !have[s.id])
  if (missing.length === 0) return have
  if (Object.keys(have).length === 0) return autoLayout(statuses, transitions)
  const maxY = Math.max(...Object.values(have).map((p) => p.y))
  const minX = Math.min(...Object.values(have).map((p) => p.x))
  missing.forEach((s, i) => { have[s.id] = { x: minX + (i % 4) * 250, y: maxY + 90 + Math.floor(i / 4) * 90 } })
  return have
}

/* ------------------------------------------------------------------ */
/*  Geometry                                                           */
/* ------------------------------------------------------------------ */

export const center = (r: Rect): Pos => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** Point where the ray from the rect's centre towards `to` leaves the rect (rounded-rect treated as a rect). */
export function clipToRect(r: Rect, to: Pos): Pos {
  const c = center(r)
  const dx = to.x - c.x
  const dy = to.y - c.y
  if (dx === 0 && dy === 0) return c
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: c.x + dx * s, y: c.y + dy * s }
}

export interface EdgeGeom {
  /** SVG path data. */
  d: string
  /** Label anchor on the curve. */
  label: Pos
  /** Arrow head tip and angle (degrees) at the target end. */
  tip: Pos
  angle: number
}

const quad = (a: Pos, c: Pos, b: Pos, t: number): Pos => ({
  x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
})

/**
 * Geometry of one edge between two rects. `bend` shifts the curve sideways
 * (px, in the frame of the canonical a->b direction) so parallel and opposite
 * edges do not overlap; 0 gives a straight line. Same rect (self loop) draws a
 * loop above the node.
 */
export function edgeGeometry(from: Rect, to: Rect, bend = 0, canonicalFlip = false): EdgeGeom {
  if (from.x === to.x && from.y === to.y && from.w === to.w) {
    const x1 = from.x + from.w * 0.3
    const x2 = from.x + from.w * 0.7
    const y = from.y
    const lift = 44 + Math.abs(bend)
    const d = `M ${x1} ${y} C ${x1 - 14} ${y - lift}, ${x2 + 14} ${y - lift}, ${x2} ${y}`
    return { d, label: { x: (x1 + x2) / 2, y: y - lift * 0.75 - 6 }, tip: { x: x2, y }, angle: 100 }
  }
  const cf = center(from)
  const ct = center(to)
  const dx = ct.x - cf.x
  const dy = ct.y - cf.y
  const len = Math.hypot(dx, dy) || 1
  // perpendicular in the canonical direction, so a->b and b->a with different slots separate
  const sign = canonicalFlip ? -1 : 1
  const nx = (-dy / len) * sign
  const ny = (dx / len) * sign
  const mid = { x: (cf.x + ct.x) / 2 + nx * bend * 2, y: (cf.y + ct.y) / 2 + ny * bend * 2 }
  const a = clipToRect(from, bend === 0 ? ct : mid)
  const b = clipToRect(to, bend === 0 ? cf : mid)
  const ctrl = { x: (a.x + b.x) / 2 + (mid.x - (cf.x + ct.x) / 2), y: (a.y + b.y) / 2 + (mid.y - (cf.y + ct.y) / 2) }
  const d = bend === 0 ? `M ${a.x} ${a.y} L ${b.x} ${b.y}` : `M ${a.x} ${a.y} Q ${ctrl.x} ${ctrl.y} ${b.x} ${b.y}`
  const label = bend === 0 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : quad(a, ctrl, b, 0.5)
  const ref = bend === 0 ? a : ctrl
  const angle = (Math.atan2(b.y - ref.y, b.x - ref.x) * 180) / Math.PI
  return { d, label, tip: b, angle }
}

/**
 * Assigns each transition a bend slot so edges between the same two nodes fan
 * out. Returns bend (px) and whether the edge runs against the canonical
 * (lower id -> higher id) direction.
 */
export function edgeSlots(transitions: DTransition[]): Map<number, { bend: number; flip: boolean }> {
  const groups = new Map<string, DTransition[]>()
  for (const t of transitions) {
    const a = t.fromStatusId ?? ANY_NODE_ID
    const key = a < t.toStatusId ? `${a}:${t.toStatusId}` : `${t.toStatusId}:${a}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  const out = new Map<number, { bend: number; flip: boolean }>()
  for (const list of groups.values()) {
    list.forEach((t, i) => {
      const a = t.fromStatusId ?? ANY_NODE_ID
      const flip = a > t.toStatusId
      const raw = (i - (list.length - 1) / 2) * 24
      // opposite directions share one canonical frame: flipping the perpendicular again keeps them apart
      out.set(t.id, { bend: flip ? -raw : raw, flip: false })
    })
  }
  return out
}

export function boundsOf(rects: Rect[], pad = 80): { x: number; y: number; w: number; h: number } {
  if (rects.length === 0) return { x: 0, y: 0, w: 600, h: 400 }
  const minX = Math.min(...rects.map((r) => r.x)) - pad
  const minY = Math.min(...rects.map((r) => r.y)) - pad - 40
  const maxX = Math.max(...rects.map((r) => r.x + r.w)) + pad
  const maxY = Math.max(...rects.map((r) => r.y + r.h)) + pad
  return { x: minX, y: minY, w: Math.max(600, maxX - minX), h: Math.max(400, maxY - minY) }
}

/** Which node (by rect) contains the point, topmost last. */
export function hitNode(rects: { id: number; rect: Rect }[], p: Pos): number | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const { id, rect } = rects[i]
    if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) return id
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  Validation + summaries                                             */
/* ------------------------------------------------------------------ */

export interface DraftTransition { name: string; fromStatusId: number | null; toStatusId: number | null }

/** Mirrors the server rules so the form can explain problems before saving. */
export function validateTransitionDraft(draft: DraftTransition, existing: DTransition[], selfId?: number): string[] {
  const errors: string[] = []
  const name = draft.name.trim()
  if (!name) errors.push('Name is required')
  else if (name.length > 255) errors.push('Name is too long (255 characters max)')
  if (draft.toStatusId === null) errors.push('Choose a target status')
  if (name && draft.toStatusId !== null) {
    const dup = existing.some((t) =>
      t.id !== selfId && t.name.trim().toLowerCase() === name.toLowerCase() &&
      t.fromStatusId === draft.fromStatusId && t.toStatusId === draft.toStatusId)
    if (dup) errors.push('A transition with this name already exists between these statuses')
  }
  return errors
}

/** Default name for a transition created by dragging: "To <target>" ("Close" style names are up to the admin). */
export function defaultTransitionName(toName: string, existing: DTransition[], from: number | null, to: number): string {
  const base = `To ${toName}`
  const taken = new Set(existing.filter((t) => t.fromStatusId === from && t.toStatusId === to).map((t) => t.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let i = 2
  while (taken.has(`${base} ${i}`.toLowerCase())) i++
  return `${base} ${i}`
}

export interface ParamDef { name: string; label: string; type: string; required: boolean; help?: string; options?: string[]; maxLength?: number; default?: string | number | null }
export interface TypeDef { type: string; label: string; description: string; params: ParamDef[] }
export type Lookups = Record<string, { id: number; name: string }[]>

/** One-line human summary of a condition / validator / post-function for chips and the table view. */
export function describeItem(item: Record<string, unknown>, defs: TypeDef[], lookups: Lookups = {}): string {
  const def = defs.find((d) => d.type === item.type)
  if (!def) return `Unsupported: ${String(item.type)}`
  const parts: string[] = []
  for (const p of def.params) {
    const v = item[p.name]
    if (v === undefined || v === null || v === '') continue
    if (p.options && p.options.length === 1) continue
    if (['role', 'group', 'resolution', 'user', 'screen'].includes(p.type)) {
      const hit = lookups[p.type]?.find((o) => o.id === v)
      parts.push(hit ? hit.name : `#${String(v)}`)
    } else if (p.type === 'text') {
      const s = String(v)
      parts.push(`"${s.length > 30 ? s.slice(0, 30) + '…' : s}"`)
    } else parts.push(String(v))
  }
  return parts.length ? `${def.label}: ${parts.join(', ')}` : def.label
}

/** Builds a fresh item for a type, pre-filling single-option enums. */
export function newItem(def: TypeDef): Record<string, unknown> {
  const item: Record<string, unknown> = { type: def.type }
  for (const p of def.params) if (p.default !== undefined && p.default !== null) item[p.name] = p.default
  return item
}

/** Client-side check that required params of an item are filled. Returns missing param labels. */
export function missingParams(item: Record<string, unknown>, defs: TypeDef[]): string[] {
  const def = defs.find((d) => d.type === item.type)
  if (!def) return ['supported type']
  return def.params.filter((p) => p.required && (item[p.name] === undefined || item[p.name] === null || item[p.name] === '')).map((p) => p.label)
}
