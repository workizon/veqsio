import { describe, test, expect } from 'bun:test'
import {
  addItem, applyKey, applyPreset, clampItem, collides, compact, defaultMetrics, detectPreset, findFreeSlot, layoutHeight,
  migrateLegacyPositions, moveItem, pxToCell, pxToSize, rectToPx, removeItem, resizeItem, sameLayout, stackOrder,
  type LayoutItem,
} from '../lib/grid-layout'
import { canRedo, canUndo, createHistory, pushState, redo, undo } from '../lib/edit-history'

const it = (id: string, x: number, y: number, w: number, h: number, extra: Partial<LayoutItem> = {}): LayoutItem => ({ id, x, y, w, h, ...extra })
const noOverlap = (items: LayoutItem[]) => items.every((a, i) => items.every((b, j) => i === j || !collides(a, b)))
const get = (items: LayoutItem[], id: string) => items.find((i) => i.id === id)!

describe('collision and clamping', () => {
  test('collides detects overlap but not touching edges', () => {
    expect(collides({ x: 0, y: 0, w: 6, h: 4 }, { x: 5, y: 3, w: 2, h: 2 })).toBe(true)
    expect(collides({ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 2, h: 2 })).toBe(false)
    expect(collides({ x: 0, y: 0, w: 6, h: 4 }, { x: 0, y: 4, w: 2, h: 2 })).toBe(false)
  })
  test('clampItem respects the grid and size limits', () => {
    expect(clampItem(it('a', 11, -3, 6, 2))).toMatchObject({ x: 6, y: 0, w: 6 })
    expect(clampItem(it('a', 0, 0, 20, 1))).toMatchObject({ w: 12 })
    expect(clampItem(it('a', 0, 0, 1, 1, { minW: 3, minH: 2 }))).toMatchObject({ w: 3, h: 2 })
    expect(clampItem(it('a', 0, 0, 9, 9, { maxW: 6, maxH: 5 }))).toMatchObject({ w: 6, h: 5 })
    expect(clampItem(it('a', Number.NaN, 0, 4, 4)).x).toBe(0)
  })
})

describe('compact and auto-pack', () => {
  test('gaps are removed and order is kept', () => {
    const out = compact([it('a', 0, 5, 6, 4), it('b', 6, 9, 6, 4), it('c', 0, 12, 6, 2)])
    expect(out.map((i) => [i.x, i.y])).toEqual([[0, 0], [6, 0], [0, 4]])
  })
  test('overlapping input is separated', () => {
    const out = compact([it('a', 0, 0, 6, 4), it('b', 0, 0, 6, 4), it('c', 3, 1, 6, 4)])
    expect(noOverlap(out)).toBe(true)
  })
  test('addItem fills the first free slot, then the bottom', () => {
    let items = [it('a', 0, 0, 6, 4)]
    items = addItem(items, { id: 'b', w: 6, h: 4 })
    expect(get(items, 'b')).toMatchObject({ x: 6, y: 0 })
    items = addItem(items, { id: 'c', w: 12, h: 3 })
    expect(get(items, 'c')).toMatchObject({ x: 0, y: 4 })
    expect(noOverlap(items)).toBe(true)
    expect(findFreeSlot([], 4, 4)).toEqual({ x: 0, y: 0 })
  })
  test('removeItem closes the gap', () => {
    const out = removeItem([it('a', 0, 0, 12, 4), it('b', 0, 4, 12, 4)], 'a')
    expect(out).toHaveLength(1)
    expect(out[0].y).toBe(0)
  })
})

describe('move and resize', () => {
  test('moving onto a gadget pushes it down', () => {
    const items = [it('a', 0, 0, 6, 4), it('b', 6, 0, 6, 4), it('c', 0, 4, 12, 3)]
    const out = moveItem(items, 'b', { x: 0, y: 0 })
    expect(noOverlap(out)).toBe(true)
    expect(get(out, 'b')).toMatchObject({ x: 0, y: 0 })
    expect(get(out, 'a').y).toBeGreaterThanOrEqual(4)
  })
  test('a moved gadget is kept inside the grid', () => {
    const out = moveItem([it('a', 0, 0, 6, 4)], 'a', { x: 30, y: 0 })
    expect(get(out, 'a').x).toBe(6)
  })
  test('resizing grows into neighbours by pushing them', () => {
    const items = [it('a', 0, 0, 6, 4), it('b', 6, 0, 6, 4)]
    const out = resizeItem(items, 'a', { w: 9, h: 4 })
    expect(noOverlap(out)).toBe(true)
    expect(get(out, 'a').w).toBe(9)
    expect(get(out, 'b').y).toBe(4)
  })
  test('resize obeys min and max', () => {
    const items = [it('a', 0, 0, 6, 4, { minW: 3, maxW: 8, minH: 2, maxH: 6 })]
    expect(resizeItem(items, 'a', { w: 1, h: 1 })[0]).toMatchObject({ w: 3, h: 2 })
    expect(resizeItem(items, 'a', { w: 12, h: 30 })[0]).toMatchObject({ w: 8, h: 6 })
  })
  test('resizing at the right edge keeps the gadget inside the grid', () => {
    const out = resizeItem([it('a', 6, 0, 6, 4)], 'a', { w: 8, h: 4 })
    expect(out[0].x + out[0].w).toBeLessThanOrEqual(12)
  })
})

describe('keyboard', () => {
  const base = [it('a', 3, 2, 4, 4), it('b', 7, 0, 4, 2)]
  test('arrows move by one cell', () => {
    expect(applyKey([it('a', 3, 0, 4, 4)], 'a', 'ArrowRight', false)[0].x).toBe(4)
    expect(applyKey([it('a', 3, 0, 4, 4)], 'a', 'ArrowLeft', false)[0].x).toBe(2)
  })
  test('moving up and down repacks without overlap', () => {
    expect(applyKey([it('a', 0, 0, 6, 4)], 'a', 'ArrowDown', false)[0].y).toBe(0)
    const two = applyKey([it('a', 0, 0, 6, 4), it('b', 0, 4, 6, 4)], 'a', 'ArrowDown', false)
    expect(noOverlap(two)).toBe(true)
  })
  test('shift+arrows resize', () => {
    expect(get(applyKey(base, 'a', 'ArrowRight', true), 'a')).toMatchObject({ w: 5 })
    expect(get(applyKey(base, 'a', 'ArrowLeft', true), 'a')).toMatchObject({ w: 3 })
    expect(get(applyKey(base, 'b', 'ArrowDown', true), 'b')).toMatchObject({ h: 3 })
  })
  test('unknown id is a no-op', () => {
    expect(applyKey(base, 'zzz', 'ArrowDown', false)).toBe(base)
  })
})

describe('presets', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, n) => it(id, (n % 2) * 6, Math.floor(n / 2) * 4, 6, 4))
  test('one column', () => {
    const out = applyPreset(six, 'one')
    expect(out.every((i) => i.x === 0 && i.w === 12)).toBe(true)
    expect(noOverlap(out)).toBe(true)
    expect(layoutHeight(out)).toBe(24)
  })
  test('three columns', () => {
    const out = applyPreset(six, 'three')
    expect(new Set(out.map((i) => i.x))).toEqual(new Set([0, 4, 8]))
    expect(out.every((i) => i.w === 4)).toBe(true)
    expect(noOverlap(out)).toBe(true)
  })
  test('wide-left / wide-right use 8+4 and 4+8 tracks', () => {
    expect(new Set(applyPreset(six, 'wide-left').map((i) => `${i.x}:${i.w}`))).toEqual(new Set(['0:8', '8:4']))
    expect(new Set(applyPreset(six, 'wide-right').map((i) => `${i.x}:${i.w}`))).toEqual(new Set(['0:4', '4:8']))
  })
  test('gadgets fill the shortest column', () => {
    const out = applyPreset([it('a', 0, 0, 6, 10), it('b', 6, 0, 6, 2), it('c', 0, 10, 6, 2)], 'two')
    expect(get(out, 'c').x).toBe(6)
  })
  test('custom leaves the layout alone', () => {
    expect(applyPreset(six, 'custom')).toBe(six)
  })
  test('detectPreset recognises what it produced', () => {
    for (const p of ['one', 'two', 'three', 'wide-left', 'wide-right'] as const) expect(detectPreset(applyPreset(six, p))).toBe(p)
    expect(detectPreset([it('a', 1, 0, 5, 4)])).toBe('custom')
    expect(detectPreset([])).toBe('two')
  })
})

describe('legacy position migration', () => {
  test('column/row become two 6-wide tracks without losing order', () => {
    const out = migrateLegacyPositions([
      { id: 'a', position: { column: 0, row: 0 } },
      { id: 'b', position: { column: 1, row: 0 } },
      { id: 'c', position: { column: 0, row: 1 } },
      { id: 'd', position: { column: 1, row: 1 } },
    ])
    expect(out.map((g) => [g.rect.x, g.rect.y, g.rect.w, g.rect.h])).toEqual([[0, 0, 6, 8], [6, 0, 6, 8], [0, 8, 6, 8], [6, 8, 6, 8]])
    expect(noOverlap(out.map((g) => ({ id: g.id, ...g.rect })))).toBe(true)
  })
  test('existing rectangles are kept and garbage positions fall back to a valid cell', () => {
    const out = migrateLegacyPositions([{ id: 'a', position: null, rect: { x: 3, y: 2, w: 5, h: 4 } }, { id: 'b', position: { column: 9, row: -4 } }])
    expect(out[0].rect).toEqual({ x: 3, y: 2, w: 5, h: 4 })
    expect(out[1].rect).toMatchObject({ x: 6, y: 0 })
  })
})

describe('pixel geometry', () => {
  const m = defaultMetrics(1200)
  test('rect <-> px round trip', () => {
    const r = { x: 3, y: 2, w: 4, h: 5 }
    const px = rectToPx(r, m)
    expect(pxToCell(px, m)).toEqual({ x: 3, y: 2 })
    expect(pxToSize(px, m)).toEqual({ w: 4, h: 5 })
  })
  test('stackOrder reads top-to-bottom, left-to-right', () => {
    expect(stackOrder([it('c', 0, 4, 12, 2), it('b', 6, 0, 6, 2), it('a', 0, 0, 6, 2)]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  test('sameLayout compares rectangles only', () => {
    expect(sameLayout([it('a', 0, 0, 6, 4)], [it('a', 0, 0, 6, 4, { minW: 2 })])).toBe(true)
    expect(sameLayout([it('a', 0, 0, 6, 4)], [it('a', 0, 1, 6, 4)])).toBe(false)
  })
})

describe('undo / redo history', () => {
  test('push, undo and redo', () => {
    let h = createHistory(1)
    h = pushState(h, 2)
    h = pushState(h, 3)
    expect(h.present).toBe(3)
    h = undo(h)
    expect(h.present).toBe(2)
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.present).toBe(3)
    expect(canUndo(h)).toBe(true)
  })
  test('a new change clears the redo stack; identical states are ignored', () => {
    let h = pushState(pushState(createHistory(1), 2), 3)
    h = undo(h)
    h = pushState(h, 9)
    expect(canRedo(h)).toBe(false)
    expect(pushState(h, 9)).toBe(h)
  })
})
