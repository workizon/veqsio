import { describe, test, expect } from 'bun:test'
import { updateBadge, validateDraft, whenLabel } from '../lib/status-updates'
import { CATEGORY_ORDER, normalizeCategory } from '../lib/workflow-graph'

describe('status update helpers', () => {
  test('badge colours differ per state and unknown states are grey', () => {
    expect(updateBadge('on_track').label).toBe('On track')
    expect(new Set(['on_track', 'at_risk', 'off_track'].map((s) => updateBadge(s).color)).size).toBe(3)
    expect(updateBadge('x').color).toBe('#667085')
  })
  test('draft validation', () => {
    expect(validateDraft(null, '')).toBe('Choose a state')
    expect(validateDraft('on_track', '')).toBeNull()
    expect(validateDraft('at_risk', 'x'.repeat(10_001))).toMatch(/limited/)
  })
  test('relative time', () => {
    const now = Date.parse('2026-05-10T12:00:00Z')
    expect(whenLabel('2026-05-10T11:59:40Z', now)).toBe('just now')
    expect(whenLabel('2026-05-10T11:15:00Z', now)).toBe('45 min ago')
    expect(whenLabel('2026-05-08T12:00:00Z', now)).toBe('2 days ago')
    expect(whenLabel('2026-01-01T00:00:00Z', now)).toBe('2026-01-01')
  })
})

describe('status groups in the designer', () => {
  test('five groups, cancelled and backlog are recognised', () => {
    expect(CATEGORY_ORDER).toEqual(['backlog', 'to_do', 'in_progress', 'done', 'cancelled'])
    expect(normalizeCategory('cancelled')).toBe('cancelled')
    expect(normalizeCategory('backlog')).toBe('backlog')
    expect(normalizeCategory('todo')).toBe('to_do')
  })
})
