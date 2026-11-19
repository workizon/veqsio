import { describe, expect, it } from 'bun:test'
import { sortRowsMulti, toggleSortKey, type SortKey } from '../lib/table-sort'

describe('toggleSortKey', () => {
  it('plain click cycles asc, desc, off', () => {
    let k: SortKey[] = []
    k = toggleSortKey(k, 'a', false); expect(k).toEqual([{ col: 'a', dir: 'asc' }])
    k = toggleSortKey(k, 'a', false); expect(k).toEqual([{ col: 'a', dir: 'desc' }])
    k = toggleSortKey(k, 'a', false); expect(k).toEqual([])
  })
  it('shift click adds keys in order and cycles each', () => {
    let k = toggleSortKey([], 'a', false)
    k = toggleSortKey(k, 'b', true); expect(k.map((x) => x.col)).toEqual(['a', 'b'])
    k = toggleSortKey(k, 'b', true); expect(k[1]).toEqual({ col: 'b', dir: 'desc' })
    k = toggleSortKey(k, 'b', true); expect(k).toEqual([{ col: 'a', dir: 'asc' }])
  })
  it('plain click on another column replaces the whole sort', () => {
    const k = toggleSortKey([{ col: 'a', dir: 'asc' }, { col: 'b', dir: 'asc' }], 'b', false)
    expect(k).toEqual([{ col: 'b', dir: 'asc' }])
  })
})

describe('sortRowsMulti', () => {
  const rows = [
    { n: 'b', g: 'x', v: 2 }, { n: 'a', g: 'y', v: 1 }, { n: 'c', g: 'x', v: null }, { n: 'd', g: 'x', v: 1 },
  ]
  const get = { n: (r: any) => r.n, g: (r: any) => r.g, v: (r: any) => r.v }
  it('sorts by the first key, then the second', () => {
    const out = sortRowsMulti(rows, get, [{ col: 'g', dir: 'asc' }, { col: 'n', dir: 'desc' }])
    expect(out.map((r) => r.n)).toEqual(['d', 'c', 'b', 'a'])
  })
  it('keeps empty values last in both directions and numbers numeric', () => {
    expect(sortRowsMulti(rows, get, [{ col: 'v', dir: 'asc' }]).map((r) => r.n)).toEqual(['a', 'd', 'b', 'c'])
    expect(sortRowsMulti(rows, get, [{ col: 'v', dir: 'desc' }]).map((r) => r.n)).toEqual(['b', 'a', 'd', 'c'])
  })
  it('ignores unknown columns', () => {
    expect(sortRowsMulti(rows, get, [{ col: 'zz', dir: 'asc' }])).toBe(rows)
  })
})
