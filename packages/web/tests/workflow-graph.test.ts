import { describe, it, expect } from 'bun:test'
import {
  autoLayout, mergeLayout, clipToRect, edgeGeometry, edgeSlots, boundsOf, hitNode, nodeWidth, nodeRect,
  validateTransitionDraft, defaultTransitionName, describeItem, newItem, missingParams, normalizeCategory,
  type DStatus, type DTransition, type TypeDef,
} from '../lib/workflow-graph'

const st = (id: number, name = `S${id}`, category = 'to_do'): DStatus => ({ id, name, category })
const tr = (id: number, from: number | null, to: number, name = `t${id}`): DTransition => ({ id, name, fromStatusId: from, toStatusId: to })

describe('normalizeCategory', () => {
  it('maps legacy and unknown values', () => {
    expect(normalizeCategory('todo')).toBe('to_do')
    expect(normalizeCategory('to_do')).toBe('to_do')
    expect(normalizeCategory('in_progress')).toBe('in_progress')
    expect(normalizeCategory('done')).toBe('done')
    expect(normalizeCategory(undefined)).toBe('to_do')
  })
})

describe('autoLayout', () => {
  const statuses = [st(1), st(2), st(3), st(4)]

  it('places a linear flow left to right', () => {
    const pos = autoLayout(statuses.slice(0, 3), [tr(1, 1, 2), tr(2, 2, 3)])
    expect(pos[1].x).toBeLessThan(pos[2].x)
    expect(pos[2].x).toBeLessThan(pos[3].x)
    expect(pos[1].y).toBe(pos[2].y)
  })

  it('stacks siblings in the same layer without overlap', () => {
    const pos = autoLayout(statuses.slice(0, 3), [tr(1, 1, 2), tr(2, 1, 3)])
    expect(pos[2].x).toBe(pos[3].x)
    expect(Math.abs(pos[2].y - pos[3].y)).toBeGreaterThanOrEqual(90)
  })

  it('handles cycles, global targets and isolated statuses deterministically', () => {
    const t = [tr(1, 1, 2), tr(2, 2, 3), tr(3, 3, 1), tr(4, null, 4)]
    const a = autoLayout(statuses, t)
    const b = autoLayout(statuses, t)
    expect(a).toEqual(b)
    expect(Object.keys(a)).toHaveLength(4)
    const all = Object.values(a)
    // no two nodes share a slot
    expect(new Set(all.map((p) => `${p.x},${p.y}`)).size).toBe(4)
    expect(all.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  it('works for an empty and a transition-less workflow', () => {
    expect(autoLayout([], [])).toEqual({})
    const pos = autoLayout([st(1), st(2)], [])
    expect(new Set(Object.values(pos).map((p) => `${p.x},${p.y}`)).size).toBe(2)
  })

  it('ignores transitions that point at unknown statuses', () => {
    const pos = autoLayout([st(1)], [tr(1, 1, 99), tr(2, 77, 1)])
    expect(Object.keys(pos)).toEqual(['1'])
  })
})

describe('mergeLayout', () => {
  it('uses auto layout when nothing is stored', () => {
    const s = [st(1), st(2)]
    expect(mergeLayout(s, [tr(1, 1, 2)], {})).toEqual(autoLayout(s, [tr(1, 1, 2)]))
    expect(mergeLayout(s, [tr(1, 1, 2)], null)).toEqual(autoLayout(s, [tr(1, 1, 2)]))
  })
  it('keeps stored positions and places new ones below', () => {
    const merged = mergeLayout([st(1), st(2)], [], { 1: { x: 500, y: 300 } })
    expect(merged[1]).toEqual({ x: 500, y: 300 })
    expect(merged[2].y).toBeGreaterThan(300)
  })
  it('drops garbage positions', () => {
    const merged = mergeLayout([st(1)], [], { 1: { x: NaN, y: 3 } } as any)
    expect(Number.isFinite(merged[1].x)).toBe(true)
  })
})

describe('geometry', () => {
  const r = { x: 0, y: 0, w: 100, h: 40 }

  it('clips the ray to the rectangle border', () => {
    expect(clipToRect(r, { x: 300, y: 20 })).toEqual({ x: 100, y: 20 })
    expect(clipToRect(r, { x: 50, y: -200 })).toEqual({ x: 50, y: 0 })
    expect(clipToRect(r, { x: 50, y: 20 })).toEqual({ x: 50, y: 20 })
  })

  it('draws a straight edge between node borders with an arrow at the target', () => {
    const g = edgeGeometry(r, { x: 300, y: 0, w: 100, h: 40 })
    expect(g.d.startsWith('M 100 20 L 300 20')).toBe(true)
    expect(g.tip).toEqual({ x: 300, y: 20 })
    expect(Math.round(g.angle)).toBe(0)
    expect(g.label).toEqual({ x: 200, y: 20 })
  })

  it('curves bent edges and loops self edges', () => {
    const b = { x: 300, y: 0, w: 100, h: 40 }
    const g = edgeGeometry(r, b, 24)
    expect(g.d).toContain(' Q ')
    expect(g.label.y).not.toBe(20)
    const loop = edgeGeometry(r, r)
    expect(loop.d).toContain(' C ')
    expect(loop.label.y).toBeLessThan(0)
  })

  it('separates opposite and parallel edges', () => {
    const slots = edgeSlots([tr(1, 1, 2), tr(2, 2, 1), tr(3, 1, 2, 'again')])
    const a = { x: 0, y: 0, w: 100, h: 40 }
    const b = { x: 300, y: 0, w: 100, h: 40 }
    const l1 = edgeGeometry(a, b, slots.get(1)!.bend).label
    const l2 = edgeGeometry(b, a, slots.get(2)!.bend).label
    const l3 = edgeGeometry(a, b, slots.get(3)!.bend).label
    const ys = [l1.y, l2.y, l3.y]
    expect(new Set(ys.map((y) => Math.round(y))).size).toBe(3)
  })

  it('a lone edge has no bend; global transitions group under the any node', () => {
    expect(edgeSlots([tr(1, 1, 2)]).get(1)!.bend).toBe(0)
    expect(edgeSlots([tr(1, null, 2), tr(2, null, 3)]).size).toBe(2)
  })

  it('computes bounds and hit testing', () => {
    const rects = [{ id: 1, rect: { x: 0, y: 0, w: 100, h: 36 } }, { id: 2, rect: { x: 50, y: 10, w: 100, h: 36 } }]
    const b = boundsOf(rects.map((x) => x.rect))
    expect(b.w).toBeGreaterThanOrEqual(600)
    expect(b.x).toBeLessThan(0)
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 600, h: 400 })
    expect(hitNode(rects, { x: 60, y: 20 })).toBe(2) // overlap: topmost wins
    expect(hitNode(rects, { x: 10, y: 5 })).toBe(1)
    expect(hitNode(rects, { x: 500, y: 500 })).toBeNull()
  })

  it('sizes lozenges by label within limits', () => {
    expect(nodeWidth('A')).toBe(96)
    expect(nodeWidth('x'.repeat(100))).toBe(220)
    expect(nodeRect(st(1, 'Open'), { x: 5, y: 6 })).toMatchObject({ x: 5, y: 6, h: 36 })
  })
})

describe('validateTransitionDraft', () => {
  const existing = [tr(1, 1, 2, 'Start')]
  it('requires name and target', () => {
    expect(validateTransitionDraft({ name: ' ', fromStatusId: 1, toStatusId: null }, existing)).toEqual(['Name is required', 'Choose a target status'])
  })
  it('detects duplicates but not itself', () => {
    expect(validateTransitionDraft({ name: 'start', fromStatusId: 1, toStatusId: 2 }, existing)).toHaveLength(1)
    expect(validateTransitionDraft({ name: 'start', fromStatusId: 1, toStatusId: 2 }, existing, 1)).toEqual([])
    expect(validateTransitionDraft({ name: 'start', fromStatusId: null, toStatusId: 2 }, existing)).toEqual([])
  })
  it('limits name length', () => {
    expect(validateTransitionDraft({ name: 'x'.repeat(256), fromStatusId: 1, toStatusId: 2 }, [])).toHaveLength(1)
  })
})

describe('defaultTransitionName', () => {
  it('avoids collisions', () => {
    expect(defaultTransitionName('Done', [], 1, 2)).toBe('To Done')
    expect(defaultTransitionName('Done', [tr(1, 1, 2, 'To Done')], 1, 2)).toBe('To Done 2')
    expect(defaultTransitionName('Done', [tr(1, 1, 2, 'To Done'), tr(2, 1, 2, 'to done 2')], 1, 2)).toBe('To Done 3')
  })
})

describe('item helpers', () => {
  const defs: TypeDef[] = [
    { type: 'user_in_group', label: 'User is in group', description: '', params: [{ name: 'group_id', label: 'Group', type: 'group', required: true }] },
    { type: 'add_comment', label: 'Add comment', description: '', params: [{ name: 'body', label: 'Comment', type: 'text', required: true }] },
    { type: 'clear_field', label: 'Clear resolution', description: '', params: [{ name: 'field', label: 'Field', type: 'enum', required: true, options: ['resolution'], default: 'resolution' }] },
  ]
  it('describes items with lookups', () => {
    expect(describeItem({ type: 'user_in_group', group_id: 3 }, defs, { group: [{ id: 3, name: 'devs' }] })).toBe('User is in group: devs')
    expect(describeItem({ type: 'user_in_group', group_id: 9 }, defs)).toBe('User is in group: #9')
    expect(describeItem({ type: 'add_comment', body: 'x'.repeat(50) }, defs)).toContain('…')
    expect(describeItem({ type: 'clear_field', field: 'resolution' }, defs)).toBe('Clear resolution')
    expect(describeItem({ type: 'custom_script' }, defs)).toBe('Unsupported: custom_script')
  })
  it('builds new items and reports missing params', () => {
    expect(newItem(defs[2])).toEqual({ type: 'clear_field', field: 'resolution' })
    expect(newItem(defs[0])).toEqual({ type: 'user_in_group' })
    expect(missingParams({ type: 'user_in_group' }, defs)).toEqual(['Group'])
    expect(missingParams({ type: 'user_in_group', group_id: 1 }, defs)).toEqual([])
    expect(missingParams({ type: 'nope' }, defs)).toEqual(['supported type'])
  })
})
