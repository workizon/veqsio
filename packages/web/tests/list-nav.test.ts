import { describe, test, expect } from 'bun:test'
import { initialListNav, listNavReducer, reconcile, type ListNavAction, type ListNavState } from '../lib/list-nav'

const ids = [10, 20, 30, 40, 50]
const run = (actions: ListNavAction[], start: ListNavState = initialListNav, list = ids) =>
  actions.reduce((s, a) => listNavReducer(s, a, list), start)

describe('list navigation reducer', () => {
  test('first move down focuses the first row, first move up the last', () => {
    expect(run([{ type: 'move', delta: 1 }]).focus).toBe(0)
    expect(run([{ type: 'move', delta: -1 }]).focus).toBe(4)
  })

  test('moves are clamped to the list', () => {
    expect(run([{ type: 'focus', index: 4 }, { type: 'move', delta: 1 }]).focus).toBe(4)
    expect(run([{ type: 'focus', index: 0 }, { type: 'move', delta: -1 }]).focus).toBe(0)
  })

  test('home and end', () => {
    expect(run([{ type: 'last' }]).focus).toBe(4)
    expect(run([{ type: 'last' }, { type: 'first' }]).focus).toBe(0)
  })

  test('empty list is a no-op', () => {
    expect(run([{ type: 'move', delta: 1 }, { type: 'toggleSelect' }, { type: 'expand' }], initialListNav, [])).toEqual(initialListNav)
  })

  test('space toggles the focused row without moving', () => {
    const s = run([{ type: 'move', delta: 1 }, { type: 'toggleSelect' }])
    expect(s.selected).toEqual([10])
    expect(s.focus).toBe(0)
    expect(run([{ type: 'move', delta: 1 }, { type: 'toggleSelect' }, { type: 'toggleSelect' }]).selected).toEqual([])
  })

  test('toggling with nothing focused does nothing', () => {
    expect(run([{ type: 'toggleSelect' }]).selected).toEqual([])
  })

  test('shift+arrows extend a range from where the focus was', () => {
    const s = run([{ type: 'focus', index: 1 }, { type: 'move', delta: 1, extend: true }, { type: 'move', delta: 1, extend: true }])
    expect(s.selected).toEqual([20, 30, 40])
    expect(s.focus).toBe(3)
  })

  test('shrinking the range deselects rows that were only added by it', () => {
    const s = run([
      { type: 'focus', index: 1 },
      { type: 'move', delta: 1, extend: true },
      { type: 'move', delta: 1, extend: true },
      { type: 'move', delta: -1, extend: true },
    ])
    expect(s.selected).toEqual([20, 30])
  })

  test('a range keeps rows that were selected before it started', () => {
    const s = run([
      { type: 'setSelection', ids: [50] },
      { type: 'focus', index: 0 },
      { type: 'move', delta: 1, extend: true },
    ])
    expect(s.selected).toEqual([10, 20, 50])
  })

  test('extending upwards works too', () => {
    const s = run([{ type: 'focus', index: 3 }, { type: 'move', delta: -1, extend: true }, { type: 'move', delta: -1, extend: true }])
    expect(s.selected).toEqual([20, 30, 40])
  })

  test('a plain move ends the range', () => {
    const s = run([{ type: 'focus', index: 0 }, { type: 'move', delta: 1, extend: true }, { type: 'move', delta: 1 }, { type: 'move', delta: 1, extend: true }])
    // new range starts at the row focused by the plain move (index 2)
    expect(s.selected).toEqual([10, 20, 30, 40])
  })

  test('expand opens the preview of the focused row and it follows the focus', () => {
    let s = run([{ type: 'move', delta: 1 }, { type: 'expand' }])
    expect(s.expanded).toBe(10)
    s = run([{ type: 'move', delta: 1 }], s)
    expect(s.expanded).toBe(20)
    s = run([{ type: 'collapse' }], s)
    expect(s.expanded).toBeNull()
    expect(s.focus).toBe(1)
  })

  test('selectAll and reset', () => {
    expect(run([{ type: 'selectAll' }]).selected).toEqual(ids)
    expect(run([{ type: 'selectAll' }, { type: 'reset' }])).toEqual(initialListNav)
  })

  test('reconcile drops vanished rows and clamps the focus', () => {
    const s = run([{ type: 'setSelection', ids: [10, 50] }, { type: 'last' }, { type: 'expand' }])
    const r = reconcile(s, [10, 20, 30])
    expect(r.selected).toEqual([10])
    expect(r.expanded).toBeNull()
    expect(r.focus).toBe(2)
    expect(reconcile(r, [10, 20, 30])).toBe(r)
    expect(reconcile(r, []).focus).toBe(-1)
  })
})
