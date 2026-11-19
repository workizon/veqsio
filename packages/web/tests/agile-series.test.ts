import { describe, expect, test } from 'bun:test'
import {
  burnupRows, formatQty, formatVelocity, percentDone, projectionSummary, releaseRows, scopeChangeSummary,
} from '../lib/agile-series'
import {
  buildLegend, cardColourStyle, colourFor, hashToken, normalizeCardColour, validateCardColour, CARD_COLOUR_TOKENS,
  type CardColourConfig, type ColourableIssue,
} from '../lib/card-colours'

describe('series formatting', () => {
  test('burnup rows drop the missing future values', () => {
    expect(burnupRows([{ date: '2026-01-01', scope: 5, completed: 0 }, { date: '2026-01-02', scope: null, completed: null }]))
      .toEqual([{ date: '2026-01-01', scope: 5, completed: 0 }, { date: '2026-01-02' }])
  })
  test('release rows keep remaining, ideal and projected', () => {
    expect(releaseRows([{ date: 'd', scope: 9, completed: 2, remaining: 7, ideal: 5.5, projected: null }]))
      .toEqual([{ date: 'd', remaining: 7, ideal: 5.5, scope: 9, completed: 2 }])
  })
  test('quantities and pace', () => {
    expect(formatQty(1, 'issues')).toBe('1 issue')
    expect(formatQty(2.456, 'points')).toBe('2.46 points')
    expect(formatQty(1, 'points')).toBe('1 point')
    expect(formatQty(3, 'hours')).toBe('3 h')
    expect(formatVelocity(0.5, 'points', 14)).toBe('0.5 points per day over the last 14 days')
    expect(formatVelocity(0, 'points', 14)).toContain('No work completed')
  })
  test('projection summary', () => {
    expect(projectionSummary(null).text).toBe('Released')
    expect(projectionSummary({ projectedDate: null, releaseDate: 'x', onTrack: null, daysLate: null }).tone).toBe('neutral')
    expect(projectionSummary({ projectedDate: '2026-02-01', releaseDate: '2026-02-10', onTrack: true, daysLate: 0 }).tone).toBe('good')
    expect(projectionSummary({ projectedDate: '2026-02-12', releaseDate: '2026-02-10', onTrack: false, daysLate: 2 })).toEqual({
      text: '2 days late: projected 2026-02-12, release 2026-02-10', tone: 'bad',
    })
  })
  test('percent and scope change text', () => {
    expect(percentDone(1, 3)).toBe(33)
    expect(percentDone(0, 0)).toBe(0)
    expect(scopeChangeSummary([], 'points')).toBe('No scope changes')
    expect(scopeChangeSummary([{ kind: 'added', size: 5 }, { kind: 'removed', size: 1 }], 'points')).toBe('+5 points added (1), -1 point removed (1)')
  })
})

const issue = (key: string, f: ColourableIssue['fields']): ColourableIssue => ({ key, fields: f })

describe('card colours', () => {
  test('normalizeCardColour tolerates missing and malformed config', () => {
    expect(normalizeCardColour(undefined)).toEqual({ by: 'none', rules: [] })
    expect(normalizeCardColour({ cardColour: { by: 'weird' } })).toEqual({ by: 'none', rules: [] })
    expect(normalizeCardColour({ cardColour: { by: 'rules', rules: [{ jql: 'a = b', colour: 'red', name: 'x' }, { jql: 'c', colour: '#fff' }, null] } }))
      .toEqual({ by: 'rules', rules: [{ name: 'x', jql: 'a = b', colour: 'red' }] })
  })

  test('priority and type use the known tokens, others a stable hash', () => {
    const p: CardColourConfig = { by: 'priority', rules: [] }
    expect(colourFor(p, issue('A-1', { priority: { name: 'High' } }))).toEqual({ token: 'orange', reason: 'High' })
    expect(colourFor(p, issue('A-1', { priority: null }))).toBeNull()
    const t: CardColourConfig = { by: 'issuetype', rules: [] }
    expect(colourFor(t, issue('A-1', { issuetype: { name: 'Bug' } }))?.token).toBe('red')
    const custom = colourFor(t, issue('A-1', { issuetype: { name: 'Spike' } }))!
    expect(custom.token).toBe(hashToken('Spike'))
    expect(custom.token).not.toBe('gray')
    expect(CARD_COLOUR_TOKENS).toContain(custom.token)
  })

  test('assignee and label modes', () => {
    const a: CardColourConfig = { by: 'assignee', rules: [] }
    expect(colourFor(a, issue('A-1', { assignee: null }))).toEqual({ token: 'gray', reason: 'Unassigned' })
    expect(colourFor(a, issue('A-1', { assignee: { displayName: 'Ada' } }))?.token).toBe(hashToken('Ada'))
    const l: CardColourConfig = { by: 'label', rules: [] }
    expect(colourFor(l, issue('A-1', { labels: ['zeta', 'alpha'] }))?.reason).toBe('alpha')
    expect(colourFor(l, issue('A-1', { labels: [] }))).toBeNull()
  })

  test('rules: first match wins and unmatched cards stay uncoloured', () => {
    const r: CardColourConfig = { by: 'rules', rules: [{ name: 'Blocked', jql: 'flagged = true', colour: 'red' }, { name: 'Rest', jql: 'x', colour: 'blue' }] }
    expect(colourFor(r, issue('A-1', {}), { 'A-1': 0 })).toEqual({ token: 'red', reason: 'Blocked' })
    expect(colourFor(r, issue('A-2', {}), { 'A-1': 0 })).toBeNull()
    expect(colourFor({ by: 'none', rules: r.rules }, issue('A-1', {}), { 'A-1': 0 })).toBeNull()
  })

  test('legend counts the colours on the board; rules keep their order', () => {
    const issues = [issue('A-1', { priority: { name: 'High' } }), issue('A-2', { priority: { name: 'High' } }), issue('A-3', { priority: { name: 'Low' } })]
    expect(buildLegend({ by: 'priority', rules: [] }, issues)).toEqual([
      { token: 'orange', label: 'High', count: 2 }, { token: 'blue', label: 'Low', count: 1 },
    ])
    expect(buildLegend({ by: 'none', rules: [] }, issues)).toEqual([])
    const r: CardColourConfig = { by: 'rules', rules: [{ name: 'B', jql: 'x', colour: 'red' }, { name: 'A', jql: 'y', colour: 'blue' }] }
    expect(buildLegend(r, issues, { 'A-1': 1, 'A-2': 0 }).map((e) => e.label)).toEqual(['B', 'A'])
  })

  test('style uses palette variables, never hex', () => {
    const s = cardColourStyle('red')
    expect(s.borderLeftColor).toBe('var(--label-red-dot)')
    expect(JSON.stringify(s)).not.toContain('#')
    expect(cardColourStyle(null)).toEqual({})
  })

  test('validation messages', () => {
    expect(validateCardColour({ by: 'rules', rules: [] })).toHaveLength(1)
    expect(validateCardColour({ by: 'rules', rules: [{ name: '', jql: ' ', colour: 'red' }] })).toEqual(['Rule 1 needs a JQL query.'])
    expect(validateCardColour({ by: 'priority', rules: [] })).toEqual([])
  })
})
