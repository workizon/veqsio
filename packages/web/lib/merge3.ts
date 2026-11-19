/**
 * Three-way merge of text by lines (the idea behind diff3). `base` is the text both people started from, `mine` is my
 * edit, `theirs` is the other person's saved version. Changes in different places combine; changes to the same lines
 * that differ are reported as conflicts instead of silently picking one. Pure and DOM-free.
 */

export interface Hunk { start: number; end: number; lines: string[] } // replaces base[start, end) with lines
export type Part = { type: 'text'; lines: string[] } | { type: 'conflict'; base: string[]; mine: string[]; theirs: string[] }
export interface MergeResult { parts: Part[]; clean: boolean; merged: string | null }

const MAX_CELLS = 4_000_000

/** Changes that turn `base` into `other`, as hunks over base line ranges. */
export function hunksOf(base: string[], other: string[]): Hunk[] {
  let pre = 0
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++
  let suf = 0
  while (suf < base.length - pre && suf < other.length - pre && base[base.length - 1 - suf] === other[other.length - 1 - suf]) suf++
  const a = base.slice(pre, base.length - suf)
  const b = other.slice(pre, other.length - suf)
  if (!a.length && !b.length) return []
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return [{ start: pre, end: pre + a.length, lines: b }]

  // LCS table over the changed middle only
  const n = a.length, m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const hunks: Hunk[] = []
  let i = 0, j = 0
  let cur: Hunk | null = null
  const flush = () => { if (cur) { hunks.push(cur); cur = null } }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue }
    if (!cur) cur = { start: pre + i, end: pre + i, lines: [] }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { cur.lines.push(b[j]); j++ } else { cur.end = pre + i + 1; i++ }
  }
  flush()
  return hunks
}

const overlaps = (x: Hunk, y: Hunk) => (x.start < y.end && y.start < x.end) || (x.start === y.start) || (x.end === y.start && x.start === x.end) || (y.end === x.start && y.start === y.end)

function apply(base: string[], from: number, to: number, hunks: Hunk[]): string[] {
  const out: string[] = []
  let pos = from
  for (const h of hunks) { out.push(...base.slice(pos, h.start), ...h.lines); pos = h.end }
  out.push(...base.slice(pos, to))
  return out
}

export function merge3(baseText: string, mineText: string, theirsText: string): MergeResult {
  if (mineText === theirsText) return { parts: [{ type: 'text', lines: mineText.split('\n') }], clean: true, merged: mineText }
  if (baseText === mineText) return { parts: [{ type: 'text', lines: theirsText.split('\n') }], clean: true, merged: theirsText }
  if (baseText === theirsText) return { parts: [{ type: 'text', lines: mineText.split('\n') }], clean: true, merged: mineText }
  const base = baseText.split('\n'), mine = mineText.split('\n'), theirs = theirsText.split('\n')
  const A = hunksOf(base, mine), B = hunksOf(base, theirs)
  const parts: Part[] = []
  const text: string[] = []
  const push = (lines: string[]) => { text.push(...lines) }
  const endText = () => { if (text.length) { parts.push({ type: 'text', lines: [...text] }); text.length = 0 } }
  let i = 0, j = 0, pos = 0
  while (i < A.length || j < B.length) {
    const a = A[i], b = B[j]
    const takeA = a && (!b || a.start <= b.start)
    const first = takeA ? a : b
    const other = takeA ? b : a
    if (!other || !overlaps(first, other)) {
      push(base.slice(pos, first.start)); push(first.lines); pos = first.end
      if (takeA) i++; else j++
      continue
    }
    // group every hunk that chains into this overlapping region
    let S = Math.min(a.start, b.start), E = Math.max(a.end, b.end)
    const ga: Hunk[] = [], gb: Hunk[] = []
    for (let grew = true; grew;) {
      grew = false
      while (i < A.length && (A[i].start < E || (A[i].start === E && A[i].start === A[i].end && E === S) || A[i].start === S)) { ga.push(A[i]); E = Math.max(E, A[i].end); i++; grew = true }
      while (j < B.length && (B[j].start < E || (B[j].start === E && B[j].start === B[j].end && E === S) || B[j].start === S)) { gb.push(B[j]); E = Math.max(E, B[j].end); j++; grew = true }
    }
    push(base.slice(pos, S)); pos = E
    const m = apply(base, S, E, ga), t = apply(base, S, E, gb)
    if (m.join('\n') === t.join('\n')) push(m)
    else { endText(); parts.push({ type: 'conflict', base: base.slice(S, E), mine: m, theirs: t }) }
  }
  push(base.slice(pos))
  endText()
  const clean = parts.every((p) => p.type === 'text')
  return { parts, clean, merged: clean ? parts.flatMap((p) => (p.type === 'text' ? p.lines : [])).join('\n') : null }
}

/** The merged text with `<<<<<<<` markers around conflicts, for the user to resolve by hand. */
export function withMarkers(r: MergeResult): string {
  return r.parts.flatMap((p) => (p.type === 'text' ? p.lines : ['<<<<<<< mine', ...p.mine, '=======', ...p.theirs, '>>>>>>> theirs'])).join('\n')
}
