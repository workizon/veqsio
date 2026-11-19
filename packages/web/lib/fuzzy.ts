/**
 * Tiny fuzzy matcher for the command palette. Pure functions, no dependencies.
 *
 * A query is split on whitespace; every word must match the text as a case-insensitive subsequence.
 * For each word the best alignment is found with a small dynamic programme that rewards matches at the
 * start of the text, after a separator or camelCase boundary, and runs of consecutive characters.
 */

export interface FuzzyResult {
  /** Higher is better. 0 for an empty query. */
  score: number
  /** Matched character ranges as half-open [start, end) pairs, sorted and merged. */
  ranges: Array<[number, number]>
}

const SEPARATORS = new Set([' ', '-', '_', '/', ':', '.', '\\', '(', ')', '[', ']', ',', '#', '>'])

const BONUS_START = 8
const BONUS_BOUNDARY = 6
const BONUS_CAMEL = 4
const BONUS_CONSECUTIVE = 5
const BASE = 2
const GAP = 1
const LEADING_GAP = 0.5
const LEADING_GAP_CAP = 8
const NEG = -1e9

function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BONUS_START
  const prev = text[i - 1]
  if (SEPARATORS.has(prev)) return BONUS_BOUNDARY
  const cur = text[i]
  if (prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase()) return BONUS_CAMEL
  if (/\d/.test(cur) && !/\d/.test(prev)) return BONUS_CAMEL
  return 0
}

/** Best alignment of a single word (no whitespace) inside text. Returns null when it is not a subsequence. */
function matchWord(word: string, text: string): FuzzyResult | null {
  const m = word.length
  const n = text.length
  if (m === 0) return { score: 0, ranges: [] }
  if (m > n) return null
  const q = word.toLowerCase()
  const t = text.toLowerCase()

  // best[i][j]: best score with q[i] matched at t[j]; from[i][j]: j of the previous query char.
  const best: number[][] = []
  const from: number[][] = []
  for (let i = 0; i < m; i++) {
    best.push(new Array(n).fill(NEG))
    from.push(new Array(n).fill(-1))
  }

  for (let j = 0; j < n; j++) {
    if (t[j] === q[0]) {
      best[0][j] = BASE + boundaryBonus(text, j) - Math.min(j, LEADING_GAP_CAP) * LEADING_GAP
    }
  }

  for (let i = 1; i < m; i++) {
    // carry = best over k <= j - 2 of best[i-1][k] - GAP * (j - k - 1), maintained incrementally.
    let carry = NEG
    let carryFrom = -1
    for (let j = i; j < n; j++) {
      if (carry > NEG) carry -= GAP
      if (j - 2 >= 0) {
        const cand = best[i - 1][j - 2]
        if (cand > carry) { carry = cand; carryFrom = j - 2 }
      }
      if (t[j] !== q[i]) continue
      const gain = BASE + boundaryBonus(text, j)
      const adjacent = best[i - 1][j - 1]
      let prevScore = NEG
      let prevFrom = -1
      if (adjacent > NEG) { prevScore = adjacent + BONUS_CONSECUTIVE; prevFrom = j - 1 }
      if (carry > prevScore) { prevScore = carry; prevFrom = carryFrom }
      if (prevScore > NEG) {
        best[i][j] = prevScore + gain
        from[i][j] = prevFrom
      }
    }
  }

  let end = -1
  let top = NEG
  for (let j = 0; j < n; j++) {
    if (best[m - 1][j] <= NEG) continue
    // tiny penalty for trailing text so "ab" ranks "ab" above "abxxxx"
    const s = best[m - 1][j] - (n - 1 - j) * 0.01
    if (s > top) { top = s; end = j }
  }
  if (end < 0) return null

  const idx: number[] = []
  let j = end
  for (let i = m - 1; i >= 0; i--) {
    idx.push(j)
    j = from[i][j]
  }
  idx.reverse()
  return { score: top, ranges: toRanges(idx) }
}

function toRanges(indices: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else if (last && last[1] > i) continue
    else out.push([i, i + 1])
  }
  return out
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { score: 0, ranges: [] }
  let score = 0
  const all: number[] = []
  for (const w of words) {
    const r = matchWord(w, text)
    if (!r) return null
    score += r.score
    for (const [a, b] of r.ranges) for (let k = a; k < b; k++) all.push(k)
  }
  // Exact and prefix matches of the whole query beat scattered ones.
  const ql = query.trim().toLowerCase()
  const tl = text.toLowerCase()
  if (tl === ql) score += 40
  else if (tl.startsWith(ql)) score += 20
  else if (tl.includes(ql)) score += 10
  return { score, ranges: toRanges(Array.from(new Set(all))) }
}

export interface Segment { text: string; match: boolean }

/** Splits text into alternating plain and matched segments for highlighting. */
export function highlightSegments(text: string, ranges: Array<[number, number]>): Segment[] {
  const out: Segment[] = []
  let pos = 0
  for (const [a, b] of ranges) {
    const s = Math.max(a, pos)
    const e = Math.min(b, text.length)
    if (e <= s) continue
    if (s > pos) out.push({ text: text.slice(pos, s), match: false })
    out.push({ text: text.slice(s, e), match: true })
    pos = e
  }
  if (pos < text.length) out.push({ text: text.slice(pos), match: false })
  return out.length ? out : [{ text, match: false }]
}
