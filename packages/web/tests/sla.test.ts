import { describe, test, expect } from 'bun:test'
import { parseDuration, formatMinutes, validateConditions, slaTone, slaProgress, conditionLabel } from '../lib/sla'

describe('parseDuration', () => {
  const cases: Array<[string, number | null]> = [
    ['4h 30m', 270], ['4h30m', 270], ['90m', 90], ['2h', 120], ['1d', 1440], ['1d 2h 5m', 1565], ['45', 45], ['2:30', 150],
    ['  8H ', 480], ['', null], ['abc', null], ['0h', null], ['0', null], ['4x', null], ['h', null], ['-5m', null], ['1:75', null],
  ]
  for (const [input, expected] of cases) test(JSON.stringify(input), () => expect(parseDuration(input)).toBe(expected))
})

describe('formatMinutes', () => {
  test('formats', () => {
    expect(formatMinutes(270)).toBe('4h 30m')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(120)).toBe('2h')
    expect(formatMinutes(1440)).toBe('24h')
  })
  test('round trip', () => { for (const m of [1, 59, 60, 61, 270, 1440, 1441]) expect(parseDuration(formatMinutes(m))).toBe(m) })
})

describe('conditions', () => {
  test('start and stop need a condition, pause may be empty', () => {
    expect(validateConditions('start', [])).toHaveLength(1)
    expect(validateConditions('stop', [])).toHaveLength(1)
    expect(validateConditions('pause', [])).toEqual([])
  })
  test('status conditions need statuses', () => {
    expect(validateConditions('start', [{ event: 'status_entered' }])).toHaveLength(1)
    expect(validateConditions('start', [{ event: 'status_entered', statusIds: [1] }])).toEqual([])
  })
  test('labels differ per block', () => {
    expect(conditionLabel('pause', 'status_entered')).toContain('in one of')
    expect(conditionLabel('start', 'status_entered')).toContain('entered')
  })
})

describe('sla display', () => {
  const base = { elapsedMs: 30, targetMs: 100, remainingMs: 70, breached: false }
  test('tone', () => {
    expect(slaTone({ ...base, status: 'running' })).toBe('ok')
    expect(slaTone({ ...base, status: 'warning' })).toBe('warning')
    expect(slaTone({ ...base, status: 'paused' })).toBe('muted')
    expect(slaTone({ ...base, status: 'met' })).toBe('met')
    expect(slaTone({ ...base, status: 'breached', breached: true })).toBe('danger')
  })
  test('progress is clamped', () => {
    expect(slaProgress({ elapsedMs: 30, targetMs: 100 })).toBe(30)
    expect(slaProgress({ elapsedMs: 300, targetMs: 100 })).toBe(100)
    expect(slaProgress({ elapsedMs: 1, targetMs: 0 })).toBe(100)
  })
})
