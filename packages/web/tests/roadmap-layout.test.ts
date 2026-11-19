import { describe, it, expect } from 'bun:test'
import { applyDrag, barGeometry, computeWindow, dayOf, headerTicks, ymd } from '../lib/roadmap-layout'

describe('roadmap layout', () => {
  it('converts between days and ISO dates', () => {
    expect(ymd(dayOf('2026-03-15T10:00:00.000Z'))).toBe('2026-03-15')
  })

  it('computes a padded window including today and versions', () => {
    const w = computeWindow([{ key: 'A-1', start: '2026-03-10T00:00:00Z', end: '2026-04-10T00:00:00Z' }], [{ startDate: null, releaseDate: '2026-06-01' }], Date.parse('2026-03-12'))
    expect(ymd(w.startDay)).toBe('2026-02-24')
    expect(w.endDay).toBeGreaterThan(dayOf('2026-06-01'))
  })

  it('has a sensible window with no data', () => {
    const w = computeWindow([], [], Date.parse('2026-01-01'))
    expect(w.endDay - w.startDay).toBeGreaterThanOrEqual(90)
  })

  it('lays out bars; open-ended items are a week wide', () => {
    const start = dayOf('2026-03-01')
    const bar = barGeometry({ key: 'A', start: '2026-03-03T00:00:00Z', end: '2026-03-05T00:00:00Z' }, start, 10)
    expect(bar).toEqual({ left: 20, width: 30, open: false })
    const open = barGeometry({ key: 'B', start: '2026-03-03T00:00:00Z', end: null }, start, 10)
    expect(open).toMatchObject({ left: 20, width: 80, open: true })
  })

  it('drags: move shifts both ends, resize clamps at the other end', () => {
    expect(applyDrag('move', 100, 110, 25, 10)).toEqual({ startDay: 103, endDay: 113 }) // 2.5 days -> rounds to 3
    expect(applyDrag('move', 100, 110, -30, 10)).toEqual({ startDay: 97, endDay: 107 })
    expect(applyDrag('resize-end', 100, 110, -500, 10)).toEqual({ startDay: 100, endDay: 100 })
    expect(applyDrag('resize-start', 100, 110, 500, 10)).toEqual({ startDay: 110, endDay: 110 })
    expect(applyDrag('resize-end', 100, 110, 40, 10)).toEqual({ startDay: 100, endDay: 114 })
  })

  it('builds header ticks per zoom level', () => {
    const s = dayOf('2026-01-01'), e = dayOf('2026-12-31')
    expect(headerTicks(s, e, 8, 'months')).toHaveLength(12)
    expect(headerTicks(s, e, 3, 'quarters').map((t) => t.label)).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'])
    const weeks = headerTicks(s, dayOf('2026-01-31'), 28, 'weeks')
    expect(weeks.length).toBeGreaterThanOrEqual(4)
    expect(weeks[0].label).toBe('5 Jan')
  })
})
