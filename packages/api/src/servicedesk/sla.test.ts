import { describe, it, expect } from 'bun:test'
import { businessMillisBetween, computeElapsedMs, pauseIntervalsFromHistory, evaluateSla, DEFAULT_BUSINESS_HOURS } from './sla'

const H = 3_600_000
// 2026-11-09 is a Monday
const mon = (h: number) => Date.UTC(2026, 10, 9, h)
const sat = (h: number) => Date.UTC(2026, 10, 14, h)

describe('business hours', () => {
  it('counts only working hours in a day', () => {
    expect(businessMillisBetween(mon(0), mon(23), DEFAULT_BUSINESS_HOURS)).toBe(9 * H)
  })
  it('skips weekends', () => {
    expect(businessMillisBetween(mon(17), Date.UTC(2026, 10, 10, 10), DEFAULT_BUSINESS_HOURS)).toBe(1 * H + 1 * H)
    expect(businessMillisBetween(sat(0), sat(23), DEFAULT_BUSINESS_HOURS)).toBe(0)
  })
  it('honours utc offset', () => {
    const hrs = { ...DEFAULT_BUSINESS_HOURS, utcOffsetMinutes: 180 }
    // 06:00-15:00 UTC == 09:00-18:00 local
    expect(businessMillisBetween(mon(0), mon(23), hrs)).toBe(9 * H)
    expect(businessMillisBetween(mon(6), mon(7), hrs)).toBe(H)
    expect(businessMillisBetween(mon(5), mon(6), hrs)).toBe(0)
  })
})

describe('elapsed', () => {
  it('24x7 subtracts pauses', () => {
    const e = computeElapsedMs({ start: mon(0), stop: mon(10), now: mon(12), pauses: [{ start: mon(2), end: mon(5) }], calendar: '24x7' })
    expect(e).toBe(7 * H)
  })
  it('uses now when running', () => {
    expect(computeElapsedMs({ start: mon(0), stop: null, now: mon(3), pauses: [], calendar: '24x7' })).toBe(3 * H)
  })
  it('overlapping pauses are merged', () => {
    const e = computeElapsedMs({ start: mon(0), stop: mon(10), now: mon(10), pauses: [{ start: mon(1), end: mon(4) }, { start: mon(3), end: mon(6) }], calendar: '24x7' })
    expect(e).toBe(5 * H)
  })
})

describe('pause intervals + evaluate', () => {
  it('builds pauses from history', () => {
    const p = pauseIntervalsFromHistory(
      [{ at: mon(2), newStatus: 'Waiting for customer' }, { at: mon(4), newStatus: 'In Progress' }, { at: mon(8), newStatus: 'Waiting for customer' }],
      new Set(['Waiting for customer']), mon(10))
    expect(p).toEqual([{ start: mon(2), end: mon(4) }, { start: mon(8), end: mon(10) }])
  })
  it('evaluates statuses', () => {
    const base = { slaId: 1, name: 'TTR', metric: 'resolution', targetMinutes: 60, paused: false, stoppedAt: null }
    expect(evaluateSla({ ...base, elapsedMs: 30 * 60_000, stopped: false }).status).toBe('running')
    expect(evaluateSla({ ...base, elapsedMs: 90 * 60_000, stopped: false }).status).toBe('breached')
    expect(evaluateSla({ ...base, elapsedMs: 30 * 60_000, stopped: true, stoppedAt: 1 }).status).toBe('met')
    expect(evaluateSla({ ...base, elapsedMs: 10, stopped: false, paused: true }).status).toBe('paused')
  })
})
