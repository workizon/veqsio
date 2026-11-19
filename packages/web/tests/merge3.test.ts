import { describe, expect, it } from 'bun:test'
import { hunksOf, merge3, withMarkers } from '../lib/merge3'

const L = (...x: string[]) => x.join('\n')

describe('merge3', () => {
  it('identical or one-sided changes need no merging', () => {
    expect(merge3('a', 'a', 'a').merged).toBe('a')
    expect(merge3('a\nb', 'a\nB', 'a\nb').merged).toBe('a\nB')
    expect(merge3('a\nb', 'a\nb', 'a\nB').merged).toBe('a\nB')
    expect(merge3('a\nb', 'a\nX', 'a\nX').merged).toBe('a\nX')
  })

  it('changes in different places combine', () => {
    const base = L('title', '', 'one', 'two', 'three', '', 'footer')
    const mine = L('TITLE', '', 'one', 'two', 'three', '', 'footer')
    const theirs = L('title', '', 'one', 'two', 'three', '', 'footer v2')
    const r = merge3(base, mine, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).toBe(L('TITLE', '', 'one', 'two', 'three', '', 'footer v2'))
  })

  it('insertions at different places and a deletion elsewhere combine', () => {
    const base = L('a', 'b', 'c', 'd')
    const r = merge3(base, L('a', 'NEW', 'b', 'c', 'd'), L('a', 'b', 'c'))
    expect(r.clean).toBe(true)
    expect(r.merged).toBe(L('a', 'NEW', 'b', 'c'))
  })

  it('the same line changed two different ways is a conflict, never a silent pick', () => {
    const r = merge3(L('a', 'b', 'c'), L('a', 'mine', 'c'), L('a', 'theirs', 'c'))
    expect(r.clean).toBe(false)
    expect(r.merged).toBeNull()
    const c = r.parts.find((p) => p.type === 'conflict') as Extract<(typeof r.parts)[number], { type: 'conflict' }>
    expect(c.mine).toEqual(['mine'])
    expect(c.theirs).toEqual(['theirs'])
    expect(c.base).toEqual(['b'])
    expect(withMarkers(r)).toBe(L('a', '<<<<<<< mine', 'mine', '=======', 'theirs', '>>>>>>> theirs', 'c'))
  })

  it('both sides making the same change is not a conflict', () => {
    const r = merge3(L('a', 'b', 'c'), L('a', 'X', 'c'), L('a', 'X', 'c', 'd'))
    expect(r.clean).toBe(true)
    expect(r.merged).toBe(L('a', 'X', 'c', 'd'))
  })

  it('a change next to a deletion of the same line conflicts; text outside conflicts survives', () => {
    const r = merge3(L('keep1', 'x', 'keep2'), L('keep1', 'x changed', 'keep2'), L('keep1', 'keep2'))
    expect(r.clean).toBe(false)
    expect(withMarkers(r)).toContain('keep1')
    expect(withMarkers(r)).toContain('keep2')
  })

  it('hunksOf finds minimal changes', () => {
    expect(hunksOf(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ start: 1, end: 2, lines: [] }])
    expect(hunksOf(['a'], ['a', 'b'])).toEqual([{ start: 1, end: 1, lines: ['b'] }])
    expect(hunksOf(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('handles a large document quickly', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const mine = [...base]; mine[100] = 'mine 100'
    const theirs = [...base]; theirs[2900] = 'theirs 2900'
    const t0 = Date.now()
    const r = merge3(base.join('\n'), mine.join('\n'), theirs.join('\n'))
    expect(r.clean).toBe(true)
    expect(r.merged!.split('\n')[100]).toBe('mine 100')
    expect(r.merged!.split('\n')[2900]).toBe('theirs 2900')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
