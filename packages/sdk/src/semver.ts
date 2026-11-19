/**
 * A deliberately small semver implementation (no dependency): parse, compare and range matching
 * for the range syntax modules need: exact, `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, `x`/`*` wildcards,
 * space separated AND, `||` OR and hyphen ranges. Pre-release tags are parsed and ordered, but a range
 * only matches a pre-release when the range itself names a pre-release on the same major.minor.patch.
 */

export interface SemVer { major: number; minor: number; patch: number; prerelease: string[] }

export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseVersion(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [] }
}

export function isValidVersion(v: string): boolean { return parseVersion(v) !== null }

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(+a - +b)
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function cmp(x: SemVer, y: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return Math.sign(x[k] - y[k])
  if (!x.prerelease.length && !y.prerelease.length) return 0
  if (!x.prerelease.length) return 1
  if (!y.prerelease.length) return -1
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i], q = y.prerelease[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const c = cmpIdent(p, q)
    if (c) return c
  }
  return 0
}

/** -1, 0 or 1. Throws on an invalid version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`)
  return cmp(x, y)
}

type Op = '=' | '>' | '>=' | '<' | '<='
interface Comparator { op: Op; v: SemVer }

const PART = '(0|[1-9]\\d*|[xX*])'
const PARTIAL = new RegExp(`^v?${PART}(?:\\.${PART}(?:\\.${PART}(?:-([0-9A-Za-z.-]+))?)?)?$`)

function fromPartial(s: string): { major?: number; minor?: number; patch?: number; pre: string[] } | null {
  const m = PARTIAL.exec(s)
  if (!m) return null
  const n = (x?: string) => (x === undefined || /^[xX*]$/.test(x) ? undefined : +x)
  const major = n(m[1]), minor = n(m[2]), patch = n(m[3])
  if (major === undefined && (minor !== undefined || patch !== undefined)) return null
  if (minor === undefined && patch !== undefined) return null
  return { major, minor, patch, pre: m[4] ? m[4].split('.') : [] }
}

const sv = (major: number, minor: number, patch: number, prerelease: string[] = []): SemVer => ({ major, minor, patch, prerelease })

function expand(op: string, token: string): Comparator[] | null {
  const p = fromPartial(token)
  if (!p) return null
  const { major, minor, patch, pre } = p
  if (major === undefined) return op === '<' || op === '>' ? [{ op: '<', v: sv(0, 0, 0) }] : []
  if (op === '^') {
    const lo = sv(major, minor ?? 0, patch ?? 0, pre)
    let hi: SemVer
    if (major > 0 || minor === undefined) hi = sv(major + 1, 0, 0)
    else if (minor > 0 || patch === undefined) hi = sv(0, minor + 1, 0)
    else hi = sv(0, 0, patch + 1)
    return [{ op: '>=', v: lo }, { op: '<', v: hi }]
  }
  if (op === '~') {
    const lo = sv(major, minor ?? 0, patch ?? 0, pre)
    const hi = minor === undefined ? sv(major + 1, 0, 0) : sv(major, minor + 1, 0)
    return [{ op: '>=', v: lo }, { op: '<', v: hi }]
  }
  const full = minor !== undefined && patch !== undefined
  const next = minor === undefined ? sv(major + 1, 0, 0) : sv(major, minor + 1, 0)
  if (op === '' || op === '=') {
    if (full) return [{ op: '=', v: sv(major, minor!, patch!, pre) }]
    return [{ op: '>=', v: sv(major, minor ?? 0, 0) }, { op: '<', v: next }]
  }
  if (op === '>=') return [{ op: '>=', v: sv(major, minor ?? 0, patch ?? 0, pre) }]
  if (op === '<') return [{ op: '<', v: sv(major, minor ?? 0, patch ?? 0, pre) }]
  if (op === '>') return full ? [{ op: '>', v: sv(major, minor!, patch!, pre) }] : [{ op: '>=', v: next }]
  if (op === '<=') return full ? [{ op: '<=', v: sv(major, minor!, patch!, pre) }] : [{ op: '<', v: next }]
  return null
}

function parseSet(set: string): Comparator[] | null {
  const hy = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(set)
  if (hy) {
    const a = expand('>=', hy[1]), b = expand('<=', hy[2])
    return a && b ? [...a, ...b] : null
  }
  const tokens = set.trim().split(/\s+/).filter(Boolean)
  const out: Comparator[] = []
  for (const t of tokens) {
    const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(t)
    if (!m) return null
    const c = expand(m[1] ?? '', m[2])
    if (!c) return null
    out.push(...c)
  }
  return out
}

function parseRange(range: string): Comparator[][] | null {
  const sets = range.split('||').map((s) => parseSet(s))
  return sets.some((s) => s === null) ? null : (sets as Comparator[][])
}

export function isValidRange(range: string): boolean { return parseRange(range) !== null }

function test(c: Comparator, v: SemVer): boolean {
  const k = cmp(v, c.v)
  switch (c.op) {
    case '=': return k === 0
    case '>': return k > 0
    case '>=': return k >= 0
    case '<': return k < 0
    case '<=': return k <= 0
  }
}

/** True when `version` satisfies `range`. Invalid input returns false. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const sets = parseRange(range)
  if (!v || !sets) return false
  return sets.some((set) => {
    if (set.length === 0) return v.prerelease.length === 0
    if (!set.every((c) => test(c, v))) return false
    if (v.prerelease.length) {
      return set.some((c) => c.v.prerelease.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch)
    }
    return true
  })
}
