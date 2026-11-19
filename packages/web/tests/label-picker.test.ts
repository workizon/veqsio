import { describe, test, expect } from 'bun:test'
import { addLabel, buildPickerRows, moveCursor, normalizeNewLabel } from '../lib/label-picker'

const options = [
  { name: 'backend', color: 'blue', issueCount: 5 },
  { name: 'back-office', color: null, issueCount: 9 },
  { name: 'urgent', color: 'red', issueCount: 2 },
  { name: 'Frontend', color: 'teal', issueCount: 1 },
]

describe('normalizeNewLabel', () => {
  test('replaces whitespace and commas with hyphens and trims', () => {
    expect(normalizeNewLabel('  needs review, soon ')).toBe('needs-review-soon')
    expect(normalizeNewLabel(',,,')).toBe('')
    expect(normalizeNewLabel('a'.repeat(150)).length).toBe(100)
  })
})

describe('buildPickerRows', () => {
  test('lists everything unselected when the query is empty, most used first', () => {
    const rows = buildPickerRows(options, ['urgent'], '')
    expect(rows.map((r) => (r.kind === 'option' ? r.option.name : 'create'))).toEqual(['back-office', 'backend', 'Frontend'])
  })
  test('prefix matches rank first and a create row is offered for new names', () => {
    const rows = buildPickerRows(options, [], 'back')
    expect(rows.map((r) => (r.kind === 'option' ? r.option.name : `+${r.name}`))).toEqual(['back-office', 'backend', '+back'])
  })
  test('no create row when the name exists (case-insensitive) or is already selected', () => {
    expect(buildPickerRows(options, [], 'FRONTEND').some((r) => r.kind === 'create')).toBe(false)
    expect(buildPickerRows(options, ['urgent'], 'urgent')).toEqual([])
  })
  test('create row uses the normalised name', () => {
    expect(buildPickerRows(options, [], 'new label')).toEqual([{ kind: 'create', name: 'new-label' }])
  })
  test('blank query yields no create row', () => {
    expect(buildPickerRows([], [], '   ')).toEqual([])
  })
})

describe('moveCursor and addLabel', () => {
  test('wraps around', () => {
    expect(moveCursor(-1, 1, 3)).toBe(0)
    expect(moveCursor(-1, -1, 3)).toBe(2)
    expect(moveCursor(2, 1, 3)).toBe(0)
    expect(moveCursor(0, -1, 3)).toBe(2)
    expect(moveCursor(0, 1, 0)).toBe(-1)
  })
  test('addLabel de-duplicates case-insensitively', () => {
    expect(addLabel(['bug'], 'Bug')).toEqual(['bug'])
    expect(addLabel(['bug'], 'new one')).toEqual(['bug', 'new-one'])
    expect(addLabel(['bug'], ' ')).toEqual(['bug'])
  })
})
