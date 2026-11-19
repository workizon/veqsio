/**
 * Pure layout maths for the 12-column dashboard grid. No React, no DOM: everything here is unit tested.
 *
 * Coordinates are grid cells: x in 0..11, y in 0.., w in 1..12, h in 1... Items never overlap after any
 * operation that returns a layout (collisions push the other gadgets down, then the layout is compacted upwards).
 */

export const GRID_COLS = 12
export const MAX_ROWS = 400

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Constraints {
  minW?: number
  minH?: number
  maxW?: number
  maxH?: number
}

export interface LayoutItem extends Rect, Constraints {
  id: string
}

export type Layout = LayoutItem[]

export type PresetId = 'one' | 'two' | 'three' | 'wide-left' | 'wide-right' | 'custom'

export const PRESETS: { id: PresetId; label: string; description: string; tracks: number[] }[] = [
  { id: 'one', label: '1 column', description: 'Every gadget full width', tracks: [12] },
  { id: 'two', label: '2 columns', description: 'Two equal columns', tracks: [6, 6] },
  { id: 'three', label: '3 columns', description: 'Three equal columns', tracks: [4, 4, 4] },
  { id: 'wide-left', label: 'Wide left', description: 'A wide column and a narrow one', tracks: [8, 4] },
  { id: 'wide-right', label: 'Wide right', description: 'A narrow column and a wide one', tracks: [4, 8] },
  { id: 'custom', label: 'Custom', description: 'Free layout', tracks: [] },
]

const int = (n: unknown, fallback: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : fallback)

/** Clamp one rectangle to the grid and to the item's size limits. */
export function clampItem<T extends LayoutItem>(item: T): T {
  const minW = Math.min(Math.max(1, item.minW ?? 1), GRID_COLS)
  const maxW = Math.min(Math.max(minW, item.maxW ?? GRID_COLS), GRID_COLS)
  const minH = Math.max(1, item.minH ?? 1)
  const maxH = Math.max(minH, item.maxH ?? MAX_ROWS)
  const w = Math.min(Math.max(int(item.w, minW), minW), maxW)
  const h = Math.min(Math.max(int(item.h, minH), minH), maxH)
  const x = Math.min(Math.max(int(item.x, 0), 0), GRID_COLS - w)
  const y = Math.min(Math.max(int(item.y, 0), 0), MAX_ROWS)
  return { ...item, x, y, w, h }
}

export function collides(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

const byPosition = (a: Rect, b: Rect) => a.y - b.y || a.x - b.x

/** Reading order (top to bottom, left to right); used for stacking on narrow screens. */
export function stackOrder<T extends Rect>(items: T[]): T[] {
  return [...items].sort(byPosition)
}

export function layoutHeight(items: Rect[]): number {
  return items.reduce((m, i) => Math.max(m, i.y + i.h), 0)
}

function firstCollision(item: Rect, others: Rect[]): Rect | undefined {
  return others.find((o) => collides(item, o))
}

/** Pull every item up as far as it goes, in reading order. Gaps between gadgets disappear. */
export function compact<T extends LayoutItem>(items: T[]): T[] {
  const placed: T[] = []
  for (const it of [...items].sort(byPosition)) {
    let cur = clampItem(it)
    while (cur.y > 0 && !firstCollision({ ...cur, y: cur.y - 1 }, placed)) cur = { ...cur, y: cur.y - 1 }
    let hit = firstCollision(cur, placed)
    while (hit) {
      cur = { ...cur, y: hit.y + hit.h }
      hit = firstCollision(cur, placed)
    }
    placed.push(cur)
  }
  // keep the caller's order
  const byId = new Map(placed.map((p) => [p.id, p]))
  return items.map((i) => byId.get(i.id)!)
}

/**
 * Put `fixedId` at its requested rectangle and push everything it overlaps downwards (recursively), then compact.
 * This is the single collision-handling routine behind drag, resize, keyboard moves and adding.
 */
export function resolveCollisions<T extends LayoutItem>(items: T[], fixedId: string): T[] {
  const fixed = items.find((i) => i.id === fixedId)
  if (!fixed) return compact(items)
  const placed: T[] = [clampItem(fixed)]
  for (const it of [...items.filter((i) => i.id !== fixedId)].sort(byPosition)) {
    let cur = clampItem(it)
    let hit = firstCollision(cur, placed)
    while (hit) {
      cur = { ...cur, y: hit.y + hit.h }
      hit = firstCollision(cur, placed)
    }
    placed.push(cur)
  }
  const byId = new Map(placed.map((p) => [p.id, p]))
  return compact(items.map((i) => byId.get(i.id)!))
}

export function moveItem<T extends LayoutItem>(items: T[], id: string, to: { x: number; y: number }): T[] {
  return resolveCollisions(items.map((i) => (i.id === id ? clampItem({ ...i, x: to.x, y: to.y }) : i)), id)
}

export function resizeItem<T extends LayoutItem>(items: T[], id: string, to: { w: number; h: number }): T[] {
  return resolveCollisions(items.map((i) => (i.id === id ? clampItem({ ...i, w: to.w, h: to.h }) : i)), id)
}

/** Replace the whole rectangle of one item (used when a drag also changes the size). */
export function setItemRect<T extends LayoutItem>(items: T[], id: string, rect: Rect): T[] {
  return resolveCollisions(items.map((i) => (i.id === id ? clampItem({ ...i, ...rect }) : i)), id)
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
export const isArrowKey = (k: string): k is ArrowKey => k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown'

/** Keyboard alternative to dragging: arrows move by one cell, Shift+arrows resize by one cell. */
export function applyKey<T extends LayoutItem>(items: T[], id: string, key: ArrowKey, shift: boolean): T[] {
  const it = items.find((i) => i.id === id)
  if (!it) return items
  const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
  const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
  return shift
    ? resizeItem(items, id, { w: it.w + dx, h: it.h + dy })
    : moveItem(items, id, { x: it.x + dx, y: it.y + dy })
}

/** Lowest free spot (reading order) where a w x h gadget fits; falls back to the bottom. */
export function findFreeSlot(items: Rect[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(Math.max(1, w), GRID_COLS)
  const bottom = layoutHeight(items)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= GRID_COLS; x++) {
      if (!firstCollision({ x, y, w: width, h }, items)) return { x, y }
    }
  }
  return { x: 0, y: bottom }
}

/** Add an item in the first free slot. */
export function addItem<T extends LayoutItem>(items: T[], item: Omit<T, 'x' | 'y'> & Partial<Rect>): T[] {
  const base = clampItem({ x: 0, y: 0, ...item } as T)
  const slot = findFreeSlot(items, base.w, base.h)
  return [...items, { ...base, ...slot }]
}

export function removeItem<T extends LayoutItem>(items: T[], id: string): T[] {
  return compact(items.filter((i) => i.id !== id))
}

/**
 * Rearrange into columns. Gadgets keep their reading order and height; each goes to the currently shortest column.
 * 'custom' returns the layout unchanged.
 */
export function applyPreset<T extends LayoutItem>(items: T[], preset: PresetId): T[] {
  const tracks = PRESETS.find((p) => p.id === preset)?.tracks ?? []
  if (!tracks.length) return items
  const starts: number[] = []
  tracks.reduce((x, w) => (starts.push(x), x + w), 0)
  const heights = tracks.map(() => 0)
  const placed = new Map<string, T>()
  for (const it of stackOrder(items)) {
    let col = 0
    for (let c = 1; c < tracks.length; c++) if (heights[c] < heights[col]) col = c
    const w = tracks[col]
    const next = clampItem({ ...it, x: starts[col], y: heights[col], w })
    // A size limit may stop the gadget filling the track; it still occupies the track's start.
    placed.set(it.id, { ...next, x: starts[col] })
    heights[col] += next.h
  }
  return compact(items.map((i) => placed.get(i.id)!))
}

/** Which preset the layout currently matches, or 'custom'. */
export function detectPreset(items: Rect[]): PresetId {
  if (items.length === 0) return 'two'
  const widths = new Set(items.map((i) => `${i.x}:${i.w}`))
  const key = [...widths].sort().join(',')
  const known: Record<string, PresetId> = {
    '0:12': 'one', '0:6,6:6': 'two', '0:4,4:4,8:4': 'three', '0:8,8:4': 'wide-left', '0:4,4:8': 'wide-right',
  }
  if (known[key]) return known[key]
  // fewer tracks in use than the preset defines (e.g. a single gadget in the first column)
  const subsetOf = (preset: PresetId) => {
    const tracks = PRESETS.find((p) => p.id === preset)!.tracks
    let x = 0
    const allowed = new Set(tracks.map((w) => { const k = `${x}:${w}`; x += w; return k }))
    return [...widths].every((k) => allowed.has(k))
  }
  for (const p of ['one', 'two', 'three', 'wide-left', 'wide-right'] as PresetId[]) if (subsetOf(p)) return p
  return 'custom'
}

/* ------------------------------------------------------------------ */
/*  Legacy positions                                                    */
/* ------------------------------------------------------------------ */

export const LEGACY_ROW_HEIGHT = 8

/**
 * Dashboards saved before the grid only had { column, row } in a 2-column list. Map that to two 6-wide
 * columns, keeping the order. Gadgets that already have a rectangle are left alone.
 */
export function migrateLegacyPositions<T extends { id: string; position?: { column?: number; row?: number } | null; rect?: Partial<Rect> | null }>(
  gadgets: T[],
  defaultSize: (g: T) => { w: number; h: number } = () => ({ w: 6, h: LEGACY_ROW_HEIGHT }),
): Array<T & { rect: Rect }> {
  const out = gadgets.map((g) => {
    const r = g.rect
    if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)) {
      return { ...g, rect: { x: r.x!, y: r.y!, w: r.w!, h: r.h! } }
    }
    const col = Math.min(Math.max(int(g.position?.column, 0), 0), 1)
    const row = Math.max(int(g.position?.row, 0), 0)
    const size = defaultSize(g)
    return { ...g, rect: { x: col * 6, y: row * LEGACY_ROW_HEIGHT, w: 6, h: size.h } }
  })
  return out
}

/* ------------------------------------------------------------------ */
/*  Pixel geometry                                                      */
/* ------------------------------------------------------------------ */

export interface Metrics {
  containerWidth: number
  rowHeight: number
  gap: number
}

export const defaultMetrics = (containerWidth: number): Metrics => ({ containerWidth, rowHeight: 30, gap: 12 })

export const colWidth = (m: Metrics) => (m.containerWidth - m.gap * (GRID_COLS - 1)) / GRID_COLS

export function rectToPx(r: Rect, m: Metrics) {
  const cw = colWidth(m)
  return {
    left: r.x * (cw + m.gap),
    top: r.y * (m.rowHeight + m.gap),
    width: r.w * cw + (r.w - 1) * m.gap,
    height: r.h * m.rowHeight + (r.h - 1) * m.gap,
  }
}

/** Nearest grid cell to a pixel offset inside the grid container. */
export function pxToCell(px: { left: number; top: number }, m: Metrics) {
  return {
    x: Math.round(px.left / (colWidth(m) + m.gap)),
    y: Math.round(px.top / (m.rowHeight + m.gap)),
  }
}

/** Nearest size in cells for a pixel size. */
export function pxToSize(px: { width: number; height: number }, m: Metrics) {
  const cw = colWidth(m)
  return {
    w: Math.round((px.width + m.gap) / (cw + m.gap)),
    h: Math.round((px.height + m.gap) / (m.rowHeight + m.gap)),
  }
}

/** Compare two layouts by rectangle only (used for the dirty indicator). */
export function sameLayout(a: Layout, b: Layout): boolean {
  if (a.length !== b.length) return false
  const m = new Map(b.map((i) => [i.id, i]))
  return a.every((i) => {
    const o = m.get(i.id)
    return !!o && o.x === i.x && o.y === i.y && o.w === i.w && o.h === i.h
  })
}
