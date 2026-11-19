import { describe, it, expect } from 'bun:test'
import {
  computeAverageAge,
  computeResolutionTime,
  parsePeriod,
  buildPeriods,
} from './gadget-stats'

const now = new Date('2026-01-10T00:00:00Z')
const d = (s: string) => new Date(s)

describe('parsePeriod', () => {
  it('defaults to daily', () => {
    expect(parsePeriod(undefined)).toBe('daily')
    expect(parsePeriod('bogus')).toBe('daily')
    expect(parsePeriod('weekly')).toBe('weekly')
    expect(parsePeriod('monthly')).toBe('monthly')
  })
})

describe('buildPeriods', () => {
  it('returns oldest-first windows ending now', () => {
    const p = buildPeriods('daily', 3, now)
    expect(p.map((x) => x.label)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10'])
  })
  it('clamps count to at least 1', () => {
    expect(buildPeriods('weekly', 0, now)).toHaveLength(1)
  })
})

describe('computeAverageAge', () => {
  it('averages age of issues open at period end', () => {
    const issues = [
      { createdAt: d('2026-01-07T00:00:00Z'), resolvedAt: null },
      { createdAt: d('2026-01-09T00:00:00Z'), resolvedAt: d('2026-01-09T12:00:00Z') },
    ]
    const r = computeAverageAge(issues, { period: 'daily', count: 3, now })
    expect(r[0]).toEqual({ date: '2026-01-08', averageDays: 1, openCount: 1 })
    // 01-09 00:00: second issue created exactly at end (open, age 0), first age 2 -> avg 1
    expect(r[1].openCount).toBe(2)
    expect(r[1].averageDays).toBe(1)
    // 01-10: second resolved, only first open, age 3d
    expect(r[2]).toEqual({ date: '2026-01-10', averageDays: 3, openCount: 1 })
  })
  it('returns zeros with no issues and ignores invalid dates', () => {
    const r = computeAverageAge(
      [{ createdAt: 'nope', resolvedAt: null }, { createdAt: null, resolvedAt: null }],
      { count: 2, now },
    )
    expect(r.every((p) => p.averageDays === 0 && p.openCount === 0)).toBe(true)
  })
})

describe('computeResolutionTime', () => {
  it('averages creation-to-resolution for issues resolved in each period', () => {
    const issues = [
      { createdAt: d('2026-01-05T00:00:00Z'), resolvedAt: d('2026-01-09T12:00:00Z') }, // 4.5d
      { createdAt: d('2026-01-08T12:00:00Z'), resolvedAt: d('2026-01-09T18:00:00Z') }, // 1.25d
      { createdAt: d('2026-01-01T00:00:00Z'), resolvedAt: null },
    ]
    const r = computeResolutionTime(issues, { period: 'daily', count: 3, now })
    expect(r[0].resolvedCount).toBe(0)
    expect(r[1]).toEqual({ date: '2026-01-09', averageDays: 0, resolvedCount: 0 })
    expect(r[2]).toEqual({ date: '2026-01-10', averageDays: 2.88, resolvedCount: 2 })
  })
  it('supports weekly buckets', () => {
    const issues = [{ createdAt: d('2026-01-01T00:00:00Z'), resolvedAt: d('2026-01-06T00:00:00Z') }]
    const r = computeResolutionTime(issues, { period: 'weekly', count: 2, now })
    expect(r[1]).toEqual({ date: '2026-01-10', averageDays: 5, resolvedCount: 1 })
    expect(r[0].resolvedCount).toBe(0)
  })
})

describe('progressOf with cancelled issues', () => {
  it('reports cancelled separately and excludes it from the total', async () => {
    const { progressOf } = await import('./gadget-data')
    expect(progressOf([{ statusCategory: 'done' }, { statusCategory: 'cancelled' }, { statusCategory: 'todo' }])).toEqual({ done: 1, inProgress: 0, todo: 1, total: 2, cancelled: 1 })
  })
})
