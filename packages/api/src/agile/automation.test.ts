import { describe, test, expect } from 'bun:test'
import { parseSprintAutomation, nextSprintName, nextSprintDates, DEFAULT_AUTOMATION } from './automation'

describe('sprint automation', () => {
  test('defaults and validation', () => {
    expect(parseSprintAutomation(undefined)).toEqual(DEFAULT_AUTOMATION)
    expect(parseSprintAutomation({ sprintAutomation: { autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'next' } })).toEqual({ autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'next' })
    expect(parseSprintAutomation({ sprintAutomation: { autoCreateNext: 'yes', durationDays: 500, autoMoveIncomplete: 'x' } })).toEqual(DEFAULT_AUTOMATION)
  })
  test('next sprint name increments the trailing number', () => {
    expect(nextSprintName('Sprint 12')).toBe('Sprint 13')
    expect(nextSprintName('2026-W09')).toBe('2026-W10')
    expect(nextSprintName('Alpha')).toBe('Alpha 2')
    expect(nextSprintName(null)).toBe('Sprint 1')
  })
  test('dates start at the completion day (UTC) and last the duration', () => {
    const d = nextSprintDates(new Date('2026-11-12T15:30:00Z'), 14)
    expect(d.startDate.toISOString()).toBe('2026-11-12T00:00:00.000Z')
    expect(d.endDate.toISOString()).toBe('2026-11-26T00:00:00.000Z')
  })
})
