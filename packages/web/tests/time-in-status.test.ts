import { describe, expect, test } from 'bun:test'
import { barShares, categoryColor, categoryLabel, formatDuration } from '../lib/time-in-status'

describe('time in status presentation', () => {
  test('formats durations', () => {
    expect(formatDuration(0)).toBe('<1m')
    expect(formatDuration(59_000)).toBe('<1m')
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
    expect(formatDuration(26 * 3_600_000)).toBe('1d 2h')
  })

  test('bar shares add up to 100 and keep a visible minimum', () => {
    const shares = barShares([{ durationMs: 1 }, { durationMs: 1_000_000 }, { durationMs: 500_000 }])
    expect(shares.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 5)
    expect(shares[0].pct).toBeGreaterThan(1)
  })

  test('zero total splits evenly', () => {
    const shares = barShares([{ durationMs: 0 }, { durationMs: 0 }])
    expect(shares.map((s) => s.pct)).toEqual([50, 50])
    expect(barShares([])).toEqual([])
  })

  test('colours and labels per category', () => {
    expect(categoryColor('done')).toBe('var(--success)')
    expect(categoryColor('todo')).toBe('var(--text-tertiary)')
    expect(categoryLabel('in_progress')).toBe('In progress')
    expect(categoryLabel('todo')).toBe('To do')
  })
})
