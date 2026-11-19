import { describe, expect, it } from 'bun:test'
import { normalizeCardLayout, CARD_FIELDS } from '../lib/card-layout'

describe('normalizeCardLayout', () => {
  it('shows everything by default', () => {
    const l = normalizeCardLayout(undefined)
    expect([...l.fields].sort()).toEqual([...CARD_FIELDS].sort())
    expect(l.size).toBe('comfortable')
  })
  it('honours a stored list, drops unknown entries, and an empty list hides all', () => {
    expect([...normalizeCardLayout({ cardFields: ['labels', 'x'], cardSize: 'compact' }).fields]).toEqual(['labels'])
    expect(normalizeCardLayout({ cardFields: ['labels'], cardSize: 'compact' }).size).toBe('compact')
    expect(normalizeCardLayout({ cardFields: [] }).fields.size).toBe(0)
  })
})
