import { describe, test, expect } from 'bun:test'
import { fuzzyMatch, highlightSegments } from '../lib/fuzzy'

const matched = (q: string, t: string) => {
  const r = fuzzyMatch(q, t)
  return r ? r.ranges.map(([a, b]) => t.slice(a, b)).join('|') : null
}

describe('fuzzyMatch', () => {
  test('empty query matches everything with no ranges', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] })
    expect(fuzzyMatch('   ', 'x')).toEqual({ score: 0, ranges: [] })
  })

  test('requires a subsequence, case-insensitive', () => {
    expect(fuzzyMatch('xyz', 'Create issue')).toBeNull()
    expect(fuzzyMatch('CI', 'Create issue')).not.toBeNull()
    expect(fuzzyMatch('ab', 'a')).toBeNull()
  })

  test('returns contiguous ranges for a substring', () => {
    expect(matched('iss', 'Create issue')).toBe('iss')
    expect(fuzzyMatch('iss', 'Create issue')!.ranges).toEqual([[7, 10]])
  })

  test('prefers word starts over scattered letters', () => {
    // "ci" should highlight the C of Create and the I of issue, not "c...i" deep inside a word
    expect(matched('ci', 'Create issue')).toBe('C|i')
    const a = fuzzyMatch('ci', 'Create issue')!
    const b = fuzzyMatch('ci', 'Acquire')!
    expect(a.score).toBeGreaterThan(b.score)
  })

  test('ranks exact and prefix matches above fuzzy ones', () => {
    const exact = fuzzyMatch('boards', 'Boards')!.score
    const prefix = fuzzyMatch('board', 'Boards')!.score
    const fuzzy = fuzzyMatch('boards', 'big orange and red dots')!.score
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(fuzzy)
  })

  test('multi-word queries need every word, in any order', () => {
    expect(fuzzyMatch('login bug', 'Bug: login page fails')).not.toBeNull()
    expect(fuzzyMatch('login crash', 'Bug: login page fails')).toBeNull()
  })

  test('issue keys match after the dash', () => {
    expect(matched('proj-12', 'PROJ-12')).toBe('PROJ-12')
    expect(fuzzyMatch('p12', 'PROJ-12')).not.toBeNull()
  })

  test('ranges are sorted, merged and inside the text', () => {
    const t = 'Open the command palette'
    const r = fuzzyMatch('o cp', t)!
    let last = 0
    for (const [a, b] of r.ranges) {
      expect(a).toBeGreaterThanOrEqual(last)
      expect(b).toBeGreaterThan(a)
      expect(b).toBeLessThanOrEqual(t.length)
      last = b
    }
  })
})

describe('highlightSegments', () => {
  test('splits text into plain and matched segments', () => {
    expect(highlightSegments('Create issue', [[0, 1], [7, 10]])).toEqual([
      { text: 'C', match: true },
      { text: 'reate ', match: false },
      { text: 'iss', match: true },
      { text: 'ue', match: false },
    ])
  })
  test('no ranges yields one plain segment', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }])
  })
  test('joined segments always equal the text', () => {
    const t = 'Assign to me'
    const r = fuzzyMatch('atm', t)!
    expect(highlightSegments(t, r.ranges).map((s) => s.text).join('')).toBe(t)
  })
  test('clamps ranges that exceed the text', () => {
    expect(highlightSegments('ab', [[1, 9]])).toEqual([{ text: 'a', match: false }, { text: 'b', match: true }])
  })
})
