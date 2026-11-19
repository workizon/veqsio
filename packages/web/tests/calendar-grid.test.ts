import { describe, test, expect } from 'bun:test'
import { monthGrid, shiftMonth, gridRange, groupByDate } from '../lib/calendar-grid'

describe('calendar grid', () => {
  test('November 2026 starts on Sunday so the first row begins on Monday 26 Oct', () => {
    const weeks = monthGrid(2026, 10)
    expect(weeks.length).toBe(6)
    expect(weeks[0][0]).toEqual({ date: '2026-10-26', day: 26, inMonth: false })
    expect(weeks[0][6]).toEqual({ date: '2026-11-01', day: 1, inMonth: true })
    expect(weeks[5][6].date).toBe('2026-12-06')
    expect(gridRange(weeks)).toEqual({ from: '2026-10-26', to: '2026-12-06' })
  })
  test('a month starting on Monday has no leading days', () => {
    expect(monthGrid(2026, 5)[0][0]).toEqual({ date: '2026-06-01', day: 1, inMonth: true })
  })
  test('shiftMonth wraps years in both directions', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
    expect(shiftMonth(2026, 3, 0)).toEqual({ year: 2026, month: 3 })
  })
  test('groupByDate ignores items without a date', () => {
    const m = groupByDate([{ d: '2026-11-03T10:00:00Z' }, { d: null }, { d: '2026-11-03' }], (x) => x.d)
    expect([...m.keys()]).toEqual(['2026-11-03'])
    expect(m.get('2026-11-03')!.length).toBe(2)
  })
})
