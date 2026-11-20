/**
 * Command line for selected issues (YouTrack-style): a small grammar that is parsed, resolved against live data
 * (users, statuses, priorities, labels, sprints, versions) and turned into a list of bulk operations for
 * POST /rest/api/2/bulk/issues. No React, no DOM, no fetch: everything here is unit tested (tests/command-line.test.ts).
 *
 *   assign me | assign <user> | for <user> | unassign
 *   status <name> | state <name>            (only statuses reachable for ALL selected issues)
 *   priority <name>
 *   label add <x> [y] | label remove <x> | label set <x>     (bare `label x` = add; `tag` is an alias)
 *   sprint <name> | sprint backlog
 *   fix version [add|remove|set] <name>
 *   watch | unwatch
 *   due <date> | due none      (today, tomorrow, +3d, in 2 weeks, friday, next friday, 2026-12-24 ...)
 *   points <n> | points none
 *   ... : comment text            or   ... --comment comment text
 *   !!  (or `repeat`)             repeat the last command
 *
 * Several clauses can follow each other: `assign me priority high label add urgent : on it`.
 * Names with spaces are quoted: status "In Progress". A value runs up to the next verb, so quote values that are verbs.
 * There is no `flag` (the API has no flag operation) and no `--silent` (the notification layer has no such switch).
 */

import { trNow } from './tr'
import { operationDef, type BulkOperation, type BulkResult, type UndoGroup } from './bulk'

/* ------------------------------------------------------------------ */
/*  Tokenizer                                                          */
/* ------------------------------------------------------------------ */

export interface Token { text: string; quoted: boolean; start: number; end: number }

export interface Tokenized {
  tokens: Token[]
  /** Text after `:` or `--comment`, trimmed; null when there is none. Empty string when the marker is there but no text. */
  comment: string | null
  /** Index of the comment marker in the input. */
  commentStart: number | null
  /** `--xyz` words that are not `--comment`. */
  options: string[]
  /** A quote was opened and never closed. */
  unterminated: boolean
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)

/** Splits a command into words. Quotes ('..' or ".." with backslash escapes) keep spaces; `:` followed by a space or the end starts the comment. */
export function tokenize(input: string): Tokenized {
  const tokens: Token[] = []
  const options: string[] = []
  let comment: string | null = null
  let commentStart: number | null = null
  let unterminated = false
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    if (isSpace(ch)) { i++; continue }
    if (ch === ':') {
      // a colon at the start of a word is always the comment marker
      comment = input.slice(i + 1).trim(); commentStart = i
      break
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = i
      i++
      let text = ''
      let closed = false
      while (i < n) {
        const c = input[i]
        if (c === '\\' && i + 1 < n && (input[i + 1] === quote || input[i + 1] === '\\')) { text += input[i + 1]; i += 2; continue }
        if (c === quote) { closed = true; i++; break }
        text += c
        i++
      }
      if (!closed) unterminated = true
      tokens.push({ text, quoted: true, start, end: i })
      continue
    }
    const start = i
    let end = i
    let colon = false
    while (end < n && !isSpace(input[end])) {
      if (input[end] === ':' && (end + 1 >= n || isSpace(input[end + 1]))) { colon = true; break }
      end++
    }
    const word = input.slice(start, end)
    if (word.toLowerCase() === '--comment') {
      comment = input.slice(end).trim(); commentStart = start
      break
    }
    if (word.startsWith('--') && word.length > 2) options.push(word)
    else if (word !== '') tokens.push({ text: word, quoted: false, start, end })
    if (colon) { comment = input.slice(end + 1).trim(); commentStart = end; break }
    i = end
  }
  return { tokens, comment, commentStart, options, unterminated }
}

/* ------------------------------------------------------------------ */
/*  Grammar                                                            */
/* ------------------------------------------------------------------ */

export type VerbId = 'assign' | 'unassign' | 'status' | 'priority' | 'label' | 'sprint' | 'fixVersion' | 'watch' | 'unwatch' | 'due' | 'points'

export interface VerbSpec {
  id: VerbId
  /** Spellings, lower case; multi-word spellings are matched as consecutive words. */
  words: string[]
  /** Takes no value. */
  bare?: boolean
  /** Shown in the verb suggestions. */
  hint: string
  example: string
}

export const VERBS: VerbSpec[] = [
  { id: 'assign', words: ['assign', 'for', 'assignee'], hint: 'Assign to a person (me, a name, none)', example: 'assign me' },
  { id: 'unassign', words: ['unassign'], bare: true, hint: 'Remove the assignee', example: 'unassign' },
  { id: 'status', words: ['status', 'state'], hint: 'Move through the workflow', example: 'status in progress' },
  { id: 'priority', words: ['priority'], hint: 'Set the priority', example: 'priority high' },
  { id: 'label', words: ['label', 'tag'], hint: 'Add, remove or replace labels', example: 'label add urgent' },
  { id: 'sprint', words: ['sprint'], hint: 'Move to a sprint (or backlog)', example: 'sprint "Sprint 4"' },
  { id: 'fixVersion', words: ['fix version', 'fixversion', 'fix-version'], hint: 'Add, remove or replace the fix version', example: 'fix version 1.2' },
  { id: 'watch', words: ['watch'], bare: true, hint: 'Start watching', example: 'watch' },
  { id: 'unwatch', words: ['unwatch'], bare: true, hint: 'Stop watching', example: 'unwatch' },
  { id: 'due', words: ['due date', 'duedate', 'due'], hint: 'Set the due date (tomorrow, +3d, next friday)', example: 'due next friday' },
  { id: 'points', words: ['story points', 'points', 'sp', 'estimate'], hint: 'Set story points', example: 'points 5' },
]

export const REPEAT_WORDS = ['!!', 'repeat']

export type ListMode = 'add' | 'remove' | 'set'
const MODE_WORDS: ListMode[] = ['add', 'remove', 'set']

/** The primary spelling shown in suggestions. */
export const verbLabel = (v: VerbSpec) => v.words.find((w) => w === 'fix version') ?? v.words[0]

export interface Clause {
  verb: VerbId
  /** The words as typed ("for", "fix version"). */
  verbText: string
  mode: ListMode | null
  /** Value tokens (quoted tokens keep their text). */
  values: Token[]
  start: number
}

export type CommandErrorCode = 'syntax' | 'unknown' | 'ambiguous' | 'missing' | 'invalid' | 'unavailable' | 'pending'
export interface CommandError { code: CommandErrorCode; message: string; candidates?: string[] }

export interface ParsedCommand {
  input: string
  clauses: Clause[]
  comment: string | null
  repeat: boolean
  errors: CommandError[]
}

/** Longest verb spelling that starts at tokens[i] (unquoted words only), with the number of words it uses. */
function verbAt(tokens: Token[], i: number): { spec: VerbSpec; words: number } | null {
  const t = tokens[i]
  if (!t || t.quoted) return null
  let best: { spec: VerbSpec; words: number } | null = null
  for (const spec of VERBS) {
    for (const w of spec.words) {
      const parts = w.split(' ')
      if (i + parts.length > tokens.length) continue
      const ok = parts.every((p, k) => !tokens[i + k].quoted && tokens[i + k].text.toLowerCase() === p)
      if (ok && (!best || parts.length > best.words)) best = { spec, words: parts.length }
    }
  }
  return best
}

/** Closest verb spelling for "Did you mean ...?" (prefix or edit distance 2). */
export function suggestVerb(word: string): string | null {
  const w = word.toLowerCase()
  let best: { word: string; d: number } | null = null
  for (const spec of VERBS) {
    for (const s of spec.words) {
      const d = s.startsWith(w) && w.length >= 2 ? 0 : editDistance(w, s)
      if (d <= 2 && (!best || d < best.d)) best = { word: s, d }
    }
  }
  return best?.word ?? null
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 2) return 3
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

export function isRepeatCommand(input: string): boolean {
  const t = input.trim().toLowerCase()
  return REPEAT_WORDS.includes(t)
}

/** Grammar only: no data needed. Errors here are about the shape of the command, not about names. */
export function parseCommand(input: string): ParsedCommand {
  const tk = tokenize(input)
  const errors: CommandError[] = []
  const out: ParsedCommand = { input, clauses: [], comment: tk.comment, repeat: false, errors }
  if (isRepeatCommand(input)) { out.repeat = true; return out }
  if (tk.unterminated) errors.push({ code: 'syntax', message: trNow('A quote is not closed.') })
  for (const o of tk.options) errors.push({ code: 'syntax', message: trNow('Unknown option {option}. Only --comment is supported.', { option: o }) })
  const tokens = tk.tokens
  if (tokens.length === 0) {
    if (tk.comment !== null) errors.push({ code: 'missing', message: trNow('A comment needs a command in front of it, for example: status done : shipped.') })
    return out
  }

  let i = 0
  while (i < tokens.length) {
    const v = verbAt(tokens, i)
    if (!v) {
      const t = tokens[i]
      const guess = t.quoted ? null : suggestVerb(t.text)
      errors.push({
        code: 'unknown',
        message: guess ? trNow('Unknown command "{command}". Did you mean "{guess}"?', { command: t.text, guess }) : trNow('Unknown command "{command}". Try assign, status, priority, label, sprint, fix version, watch, due or points.', { command: t.text }),
        candidates: guess ? [guess] : undefined,
      })
      // skip to the next verb so later clauses are still checked
      i++
      while (i < tokens.length && !verbAt(tokens, i)) i++
      continue
    }
    const first = tokens[i]
    const verbText = tokens.slice(i, i + v.words).map((t) => t.text).join(' ')
    i += v.words
    const values: Token[] = []
    while (i < tokens.length && !verbAt(tokens, i)) values.push(tokens[i++])
    let mode: ListMode | null = null
    if ((v.spec.id === 'label' || v.spec.id === 'fixVersion') && values.length > 0 && !values[0].quoted && (MODE_WORDS as string[]).includes(values[0].text.toLowerCase())) {
      mode = values[0].text.toLowerCase() as ListMode
      values.shift()
    }
    if (v.spec.bare && values.length > 0) {
      errors.push({ code: 'syntax', message: trNow('"{verb}" takes no value (found "{value}").', { verb: verbText, value: values.map((t) => t.text).join(' ') }) })
    } else if (!v.spec.bare && values.length === 0 && !(mode === 'set' && (v.spec.id === 'label' || v.spec.id === 'fixVersion'))) {
      errors.push({ code: 'missing', message: trNow('"{verb}" needs a value, for example: {example}', { verb: verbText, example: v.spec.example }) })
    }
    out.clauses.push({ verb: v.spec.id, verbText, mode, values, start: first.start })
  }

  const seen = new Map<string, number>()
  for (const c of out.clauses) {
    const group = c.verb === 'unassign' ? 'assign' : c.verb === 'unwatch' ? 'watch' : c.verb
    const key = c.verb === 'label' || c.verb === 'fixVersion' ? `${group}:${c.mode ?? 'add'}` : group
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) errors.push({ code: 'syntax', message: trNow('"{verb}" is given {n} times; use one clause.', { verb: k.split(':')[0], n }) })
  return out
}

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const pad = (n: number) => String(n).padStart(2, '0')
export const formatIsoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n) }
function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last))
}

function weekdayIndex(word: string): number {
  const w = word.toLowerCase()
  if (w.length < 3) return -1
  return WEEKDAYS.findIndex((d) => d === w || (w.length === 3 && d.startsWith(w)) || (w === 'tues' && d === 'tuesday') || (w === 'thur' && d === 'thursday') || (w === 'thurs' && d === 'thursday'))
}

/**
 * Turns a typed date into `YYYY-MM-DD` (local time), or null when it is not understood.
 *
 * Understood: `2026-12-24`, today, tomorrow, yesterday, `+3d` / `3d` / `in 3 days`, `+2w` / `in 2 weeks`, `+1m` / `in a month`,
 * a weekday (`friday` = the next one after today), `next friday` (that weekday in NEXT calendar week, weeks start on Monday),
 * `next week` (Monday), `next month` (same day), `end of week` / `eow` (Friday), `end of month` / `eom`.
 */
export function parseRelativeDate(text: string, now: Date = new Date()): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === '') return null
  const today = startOfDay(now)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    const dt = new Date(y, m - 1, d)
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? t : null
  }
  if (t === 'today' || t === 'now') return formatIsoDate(today)
  if (t === 'tomorrow' || t === 'tmrw' || t === 'tom') return formatIsoDate(addDays(today, 1))
  if (t === 'yesterday') return formatIsoDate(addDays(today, -1))

  const offset = /^(?:in )?([+-]?)(\d+|an?) ?(d|day|days|w|wk|week|weeks|m|mo|month|months)(?: ago)?$/.exec(t)
  if (offset) {
    const qty = /^an?$/.test(offset[2]) ? 1 : Number(offset[2])
    const ago = t.endsWith(' ago')
    const sign = (offset[1] === '-' ? -1 : 1) * (ago ? -1 : 1)
    const unit = offset[3][0]
    if (!Number.isFinite(qty) || qty > 3650) return null
    if (unit === 'd') return formatIsoDate(addDays(today, sign * qty))
    if (unit === 'w') return formatIsoDate(addDays(today, sign * qty * 7))
    return formatIsoDate(addMonths(today, sign * qty))
  }

  if (t === 'next week') return formatIsoDate(addDays(today, 7 - ((today.getDay() + 6) % 7)))
  if (t === 'next month') return formatIsoDate(addMonths(today, 1))
  if (t === 'end of week' || t === 'eow') {
    const toFriday = (5 - today.getDay() + 7) % 7
    return formatIsoDate(addDays(today, toFriday))
  }
  if (t === 'end of month' || t === 'eom') return formatIsoDate(new Date(today.getFullYear(), today.getMonth() + 1, 0))

  const nextDay = /^next (\w+)$/.exec(t)
  if (nextDay) {
    const wd = weekdayIndex(nextDay[1])
    if (wd < 0) return null
    const mondayNextWeek = addDays(today, 7 - ((today.getDay() + 6) % 7))
    return formatIsoDate(addDays(mondayNextWeek, (wd + 6) % 7))
  }
  const plain = /^(?:this )?(\w+)$/.exec(t)
  if (plain) {
    const wd = weekdayIndex(plain[1])
    if (wd < 0) return null
    const delta = ((wd - today.getDay() + 7) % 7) || 7
    return formatIsoDate(addDays(today, delta))
  }
  return null
}

/** "Fri 14 Nov 2026" for the preview line (not locale dependent so tests are stable). */
export function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[dt.getDay()]} ${d} ${months[m - 1]} ${y}`
}

/* ------------------------------------------------------------------ */
/*  Name matching                                                      */
/* ------------------------------------------------------------------ */

export type Match<T> = { kind: 'one'; item: T } | { kind: 'none' } | { kind: 'many'; items: T[] }

/**
 * Finds the one item a typed name stands for. Tiers, first non-empty wins: exact name, name starts with the text,
 * a word of the name starts with it, name contains it. Within a tier, more than one hit is ambiguous.
 */
export function matchName<T>(items: T[], query: string, names: (item: T) => string[]): Match<T> {
  const q = query.trim().toLowerCase()
  if (q === '') return { kind: 'none' }
  const lower = (item: T) => names(item).filter(Boolean).map((s) => s.toLowerCase())
  const tiers: Array<(s: string) => boolean> = [
    (s) => s === q,
    (s) => s.startsWith(q),
    (s) => s.split(/[\s@._-]+/).some((w) => w.startsWith(q)),
    (s) => s.includes(q),
  ]
  for (const test of tiers) {
    const hits = items.filter((it) => lower(it).some(test))
    if (hits.length === 1) return { kind: 'one', item: hits[0] }
    if (hits.length > 1) return { kind: 'many', items: hits }
  }
  return { kind: 'none' }
}

/* ------------------------------------------------------------------ */
/*  Resolver                                                           */
/* ------------------------------------------------------------------ */

export interface UserRef { id: number; displayName: string; name?: string; email?: string }
export interface TransitionOption {
  id: number; name: string; to: { id: number; name: string }; count: number
  requiresComment?: boolean; requiresResolution?: boolean
}
export interface TransitionData {
  total: number
  transitions: TransitionOption[]
  commonIds: number[]
  unavailable: Array<{ key: string; reason: string }>
}
export interface NamedRef { id: number; name: string }
export interface SprintRef extends NamedRef { state?: string | null }

export interface ResolveContext {
  now: Date
  me: UserRef | null
  users: UserRef[]
  priorities: NamedRef[]
  /** null while loading or when it cannot be loaded. */
  transitions: TransitionData | null
  labels: string[]
  /** null = not available (several projects selected, or still loading). */
  sprints: SprintRef[] | null
  versions: NamedRef[] | null
  issueKeys: string[]
  projectKeys: string[]
}

export const emptyContext = (now: Date = new Date()): ResolveContext => ({
  now, me: null, users: [], priorities: [], transitions: null, labels: [], sprints: null, versions: null, issueKeys: [], projectKeys: [],
})

export interface PlannedOperation {
  operation: BulkOperation
  params: Record<string, unknown>
  /** Imperative phrase for the preview: "set status to Done". */
  summary: string
  undoable: boolean
}

export interface Resolution {
  ok: boolean
  operations: PlannedOperation[]
  /** A comment for each issue, posted after the operations. */
  comment: string | null
  errors: CommandError[]
  warnings: string[]
  /** Some data the command needs is still loading: show "checking", not an error. */
  pending: boolean
  /** Every operation can be undone with one click (a comment cannot be taken back and does not count). */
  undoable: boolean
  /** At least one operation can be undone. */
  partlyUndoable: boolean
}

const quoteIfNeeded = (s: string) => (/\s/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s)
const joinValues = (c: Clause) => c.values.map((t) => t.text).join(' ').trim()

function describeMany(items: string[], max = 5): string[] { return items.slice(0, max) }

function userLabel(u: UserRef) { return u.displayName || u.name || String(u.id) }

function resolveUser(text: string, ctx: ResolveContext): { id: number | null; label: string } | CommandError {
  const q = text.trim()
  const lower = q.toLowerCase()
  if (['none', 'nobody', 'unassigned', 'unassign', 'no one', '-'].includes(lower)) return { id: null, label: 'nobody' }
  if (lower === 'me' || lower === 'myself' || lower === 'i') {
    return ctx.me ? { id: ctx.me.id, label: 'you' } : { code: 'pending', message: trNow('Your user is still loading.') }
  }
  const m = matchName(ctx.users, q, (u) => [u.displayName, u.name ?? '', u.email ?? '', (u.email ?? '').split('@')[0]])
  if (m.kind === 'one') return { id: m.item.id, label: userLabel(m.item) }
  if (m.kind === 'many') {
    const names = describeMany(m.items.map(userLabel))
    return { code: 'ambiguous', message: trNow('"{query}" matches {n} users: {names}. Type more of the name.', { query: q, n: m.items.length, names: names.join(', ') + (m.items.length > names.length ? ', ...' : '') }), candidates: names }
  }
  return { code: 'unknown', message: trNow('Unknown user "{query}".', { query: q }) }
}

const isError = (x: unknown): x is CommandError => typeof x === 'object' && x !== null && 'code' in x && 'message' in x

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}` }

/** Resolves parsed clauses against live data. Never throws: problems come back in `errors`. */
export function resolveCommand(parsed: ParsedCommand, ctx: ResolveContext): Resolution {
  const errors: CommandError[] = [...parsed.errors]
  const warnings: string[] = []
  const ops: PlannedOperation[] = []
  let pending = false
  const fail = (e: CommandError) => { errors.push(e); if (e.code === 'pending') pending = true }
  const editFields: Record<string, unknown> = {}
  const editParts: string[] = []
  let comment = parsed.comment && parsed.comment.length > 0 ? parsed.comment : null
  const single = ctx.projectKeys.length === 1
  const push = (operation: BulkOperation, params: Record<string, unknown>, summary: string) =>
    ops.push({ operation, params, summary, undoable: operationDef(operation).undoable })

  if (ctx.issueKeys.length === 0 && parsed.clauses.length > 0) {
    errors.push({ code: 'missing', message: trNow('No issue is selected. Select issues in the list (or open one) first.') })
  }
  if (parsed.comment !== null && parsed.comment === '' && parsed.clauses.length > 0) {
    errors.push({ code: 'missing', message: trNow('The comment after ":" is empty.') })
  }

  for (const c of parsed.clauses) {
    const text = joinValues(c)
    switch (c.verb) {
      case 'unassign': push('assign', { assigneeId: null }, 'unassign'); break
      case 'assign': {
        if (c.values.length === 0) break
        const u = resolveUser(text, ctx)
        if (isError(u)) fail(u)
        else push('assign', { assigneeId: u.id }, u.id === null ? 'unassign' : `assign to ${u.label}`)
        break
      }
      case 'priority': {
        if (c.values.length === 0) break
        const m = matchName(ctx.priorities, text, (p) => [p.name])
        if (m.kind === 'one') push('priority', { priorityId: m.item.id }, `set priority to ${m.item.name}`)
        else if (m.kind === 'many') fail({ code: 'ambiguous', message: trNow('"{query}" matches priorities {names}.', { query: text, names: m.items.map((p) => p.name).join(', ') }), candidates: m.items.map((p) => p.name) })
        else if (ctx.priorities.length === 0) fail({ code: 'pending', message: trNow('Priorities are still loading.') })
        else fail({ code: 'unknown', message: trNow('Unknown priority "{query}". Available: {names}.', { query: text, names: ctx.priorities.map((p) => p.name).join(', ') }), candidates: ctx.priorities.map((p) => p.name) })
        break
      }
      case 'status': {
        if (c.values.length === 0) break
        const data = ctx.transitions
        if (!data) { fail({ code: 'pending', message: trNow('Checking which statuses the selected issues can move to.') }); break }
        if (data.transitions.length === 0) { fail({ code: 'unavailable', message: trNow('No status change is available for the selected issues.') }); break }
        // one entry per target status; the match also accepts the transition's own name ("Start progress")
        const byTarget = new Map<string, TransitionOption[]>()
        for (const t of data.transitions) byTarget.set(t.to.name, [...(byTarget.get(t.to.name) ?? []), t])
        const targets = [...byTarget.entries()].map(([name, list]) => ({ name, list }))
        const m = matchName(targets, text, (t) => [t.name, ...t.list.map((x) => x.name)])
        if (m.kind === 'none') { fail({ code: 'unknown', message: trNow('Unknown status "{query}". Reachable: {names}.', { query: text, names: targets.map((t) => t.name).join(', ') }), candidates: targets.map((t) => t.name) }); break }
        if (m.kind === 'many') { fail({ code: 'ambiguous', message: trNow('"{query}" matches statuses {names}.', { query: text, names: m.items.map((t) => t.name).join(', ') }), candidates: m.items.map((t) => t.name) }); break }
        const common = new Set(data.commonIds)
        const usable = m.item.list.find((t) => common.has(t.id))
        if (!usable) {
          const most = Math.max(...m.item.list.map((t) => t.count))
          fail({ code: 'unavailable', message: trNow('{status} is not reachable for all {total} selected issues ({issues} can move there). Narrow the selection or use Bulk change.', { status: m.item.name, total: data.total, issues: plural(most, 'issue') }) })
          break
        }
        if (usable.requiresComment && !comment) { fail({ code: 'missing', message: trNow('Moving to {status} needs a comment. Add it after a colon: status {value} : your comment', { status: m.item.name, value: quoteIfNeeded(m.item.name) }) }); break }
        if (data.unavailable.length > 0) warnings.push(trNow('{issues} cannot be transitioned by you.', { issues: plural(data.unavailable.length, 'selected issue') }))
        // the comment travels with the transition so it is posted together with the status change
        push('transition', { transitionId: usable.id, ...(comment ? { comment } : {}) }, `set status to ${m.item.name}`)
        comment = null
        break
      }
      case 'label': {
        const mode: ListMode = c.mode ?? 'add'
        const names = c.values.map((t) => t.text)
        if (mode !== 'set' && names.length === 0) break
        const bad = names.find((n) => /[\s,]/.test(n))
        if (bad) { fail({ code: 'invalid', message: trNow('Label "{label}" cannot contain spaces or commas.', { label: bad }) }); break }
        const known = new Map(ctx.labels.map((l) => [l.toLowerCase(), l]))
        const fixed = [...new Set(names.map((n) => known.get(n.toLowerCase()) ?? n))]
        if (mode === 'remove') {
          const missing = fixed.filter((n) => ctx.labels.length > 0 && !known.has(n.toLowerCase()))
          if (missing.length > 0) warnings.push(trNow(missing.length === 1 ? 'No issue uses the label {names}.' : 'No issue uses the labels {names}.', { names: missing.join(', ') }))
        }
        const phrase = mode === 'add' ? `add ${plural(fixed.length, 'label')} ${fixed.join(', ')}` : mode === 'remove' ? `remove ${plural(fixed.length, 'label')} ${fixed.join(', ')}` : fixed.length === 0 ? 'remove all labels' : `set labels to ${fixed.join(', ')}`
        push('label', { [mode]: fixed }, phrase)
        break
      }
      case 'sprint': {
        if (c.values.length === 0) break
        if (!single) { fail({ code: 'unavailable', message: trNow('Sprint works on one project at a time. Your selection spans {projects}.', { projects: ctx.projectKeys.length === 0 ? trNow('no project') : ctx.projectKeys.join(', ') }) }); break }
        if (['backlog', 'none', 'no sprint'].includes(text.toLowerCase())) { push('sprint', { sprintId: null }, 'move to the backlog'); break }
        if (!ctx.sprints) { fail({ code: 'pending', message: trNow('Loading sprints.') }); break }
        const m = matchName(ctx.sprints, text, (s) => [s.name])
        if (m.kind === 'one') push('sprint', { sprintId: m.item.id }, `move to sprint ${m.item.name}`)
        else if (m.kind === 'many') fail({ code: 'ambiguous', message: trNow('"{query}" matches sprints {names}.', { query: text, names: m.items.map((s) => s.name).join(', ') }), candidates: m.items.map((s) => s.name) })
        else fail({ code: 'unknown', message: ctx.sprints.length ? trNow('Unknown sprint "{query}". Open sprints: {names}.', { query: text, names: ctx.sprints.map((s) => s.name).join(', ') }) : trNow('Unknown sprint "{query}". There is no open sprint.', { query: text }) })
        break
      }
      case 'fixVersion': {
        const mode: ListMode = c.mode ?? 'add'
        if (!single) { fail({ code: 'unavailable', message: trNow('Fix versions work on one project at a time. Your selection spans {projects}.', { projects: ctx.projectKeys.length === 0 ? trNow('no project') : ctx.projectKeys.join(', ') }) }); break }
        if (!ctx.versions) { fail({ code: 'pending', message: trNow('Loading versions.') }); break }
        if (c.values.length === 0) { if (mode === 'set') { push('fixVersion', { set: [] }, 'clear the fix version'); } break }
        const ids: number[] = []
        const names: string[] = []
        let bad = false
        // several values: each token is one version (quote names with spaces); a single value may hold spaces
        const wanted = c.values.length > 1 && c.values.every((t) => !/\s/.test(t.text)) ? c.values.map((t) => t.text) : [text]
        for (const w of wanted) {
          const m = matchName(ctx.versions, w, (v) => [v.name])
          if (m.kind === 'one') { ids.push(m.item.id); names.push(m.item.name) }
          else { bad = true; fail(m.kind === 'many' ? { code: 'ambiguous', message: trNow('"{query}" matches versions {names}.', { query: w, names: m.items.map((v) => v.name).join(', ') }), candidates: m.items.map((v) => v.name) } : { code: 'unknown', message: ctx.versions.length ? trNow('Unknown version "{query}". Versions: {names}.', { query: w, names: ctx.versions.map((v) => v.name).join(', ') }) : trNow('Unknown version "{query}". This project has no versions.', { query: w }) }) }
        }
        if (!bad) push('fixVersion', { [mode]: [...new Set(ids)] }, `${mode === 'add' ? 'add' : mode === 'remove' ? 'remove' : 'set'} fix version ${names.join(', ')}`)
        break
      }
      case 'watch': push('watch', {}, 'watch'); break
      case 'unwatch': push('unwatch', {}, 'stop watching'); break
      case 'due': {
        if (c.values.length === 0) break
        if (['none', 'clear', 'remove', 'no'].includes(text.toLowerCase())) { editFields.duedate = null; editParts.push('clear the due date'); break }
        const d = parseRelativeDate(text, ctx.now)
        if (!d) fail({ code: 'invalid', message: trNow('"{query}" is not a date. Try tomorrow, +3d, next friday or 2026-12-24.', { query: text }) })
        else { editFields.duedate = d; editParts.push(`set the due date to ${formatDateLong(d)}`) }
        break
      }
      case 'points': {
        if (c.values.length === 0) break
        if (['none', 'clear', 'remove'].includes(text.toLowerCase())) { editFields.storyPoints = null; editParts.push('clear story points'); break }
        const n = Number(text.replace(',', '.'))
        if (!Number.isFinite(n) || n < 0 || n > 1000 || Math.round(n * 100) / 100 !== n || text === '') fail({ code: 'invalid', message: trNow('Story points must be a number from 0 to 1000 (up to 2 decimals), not "{query}".', { query: text }) })
        else { editFields.storyPoints = n; editParts.push(`set story points to ${n}`) }
        break
      }
    }
  }
  if (editParts.length > 0) push('edit', { fields: editFields }, editParts.join(' and '))

  const hard = errors.length > 0
  const undoable = ops.length > 0 && ops.every((o) => o.undoable)
  return {
    ok: !hard && ops.length > 0 && !pending,
    operations: hard ? [] : ops,
    comment,
    errors,
    warnings,
    pending,
    undoable,
    partlyUndoable: ops.some((o) => o.undoable),
  }
}

/** Parse + resolve in one call. */
export function resolveInput(input: string, ctx: ResolveContext): Resolution {
  return resolveCommand(parseCommand(input), ctx)
}

/** "Will set status to Done for 12 issues" (plus the comment and what cannot be undone). */
export function previewLine(res: Resolution, issueCount: number): string {
  if (res.operations.length === 0 && !res.comment) return ''
  const parts = res.operations.map((o) => o.summary)
  if (res.comment) parts.push('add a comment')
  const list = parts.length <= 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Will ${list} for ${plural(issueCount, 'issue')}`
}

/* ------------------------------------------------------------------ */
/*  Run summary                                                        */
/* ------------------------------------------------------------------ */

export interface CommentOutcome { posted: number; failed: number }

export interface RunSummary {
  tone: 'success' | 'warning' | 'error'
  headline: string
  failedKeys: string[]
  /** Undo calls, newest operation first. */
  undo: UndoGroup[]
  canUndo: boolean
}

/** One sentence for the toast / live region, and the undo groups of everything that changed. */
export function summarizeRun(results: BulkResult[], issueCount: number, comment?: CommentOutcome | null): RunSummary {
  const failedKeys = [...new Set(results.flatMap((r) => r.failed.map((f) => f.key)))]
  const okOps = results.filter((r) => r.failed.length === 0 && r.succeeded.length > 0).length
  const noneOk = results.every((r) => r.succeeded.length === 0)
  const tone: RunSummary['tone'] = noneOk && results.length > 0 ? 'error' : failedKeys.length > 0 || (comment?.failed ?? 0) > 0 ? 'warning' : 'success'
  let headline: string
  if (results.length === 0) headline = comment ? `Comment added to ${plural(comment.posted, 'issue')}.` : 'Nothing to do.'
  else if (results.length === 1) {
    const r = results[0]
    const done = operationDef(r.operation).done
    headline = r.failed.length === 0
      ? `${plural(r.succeeded.length, 'issue')} ${done}.`
      : r.succeeded.length === 0 ? `No issues were ${done}; ${r.failed.length} failed${r.failed[0] ? `: ${r.failed[0].reason}` : ''}.` : `${r.succeeded.length} of ${plural(r.succeeded.length + r.failed.length, 'issue')} ${done}; ${r.failed.length} failed.`
  } else {
    headline = okOps === results.length
      ? `${plural(results.length, 'change')} applied to ${plural(issueCount, 'issue')}.`
      : `${okOps} of ${plural(results.length, 'change')} applied completely; ${plural(failedKeys.length, 'issue')} had problems.`
  }
  if (comment && comment.failed > 0) headline += ` ${plural(comment.failed, 'comment')} could not be posted.`
  const undo: UndoGroup[] = []
  for (const r of [...results].reverse()) {
    for (const g of r.undo ?? []) {
      const keys = g.issueKeys.filter((k) => r.succeeded.includes(k))
      if (keys.length > 0) undo.push({ ...g, issueKeys: keys })
    }
  }
  return { tone, headline, failedKeys, undo, canUndo: undo.length > 0 }
}

/* ------------------------------------------------------------------ */
/*  Completion                                                         */
/* ------------------------------------------------------------------ */

export type SuggestionKind = 'verb' | 'user' | 'status' | 'priority' | 'label' | 'sprint' | 'version' | 'mode' | 'date' | 'number' | 'repeat'

export interface Suggestion {
  kind: SuggestionKind
  /** Shown in the list. */
  label: string
  /** Replaces the fragment being typed. */
  insert: string
  detail?: string
}

export interface Completion {
  /** Index in the input where the fragment being completed starts. */
  from: number
  fragment: string
  suggestions: Suggestion[]
  /** What the cursor is waiting for ("a user", "a status"), for the hint line. */
  expecting: string | null
}

const MAX_SUGGESTIONS = 8

function rank<T extends { label: string }>(items: T[], fragment: string): T[] {
  const f = fragment.toLowerCase()
  if (f === '') return items
  const tier = (s: string) => {
    const l = s.toLowerCase()
    return l.startsWith(f) ? 0 : l.split(/[\s@._-]+/).some((w) => w.startsWith(f)) ? 1 : l.includes(f) ? 2 : 3
  }
  return items.map((it, i) => ({ it, i, t: tier(it.label) })).filter((x) => x.t < 3).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.it)
}

function verbSuggestions(fragment: string): Suggestion[] {
  const f = fragment.toLowerCase()
  const out: Suggestion[] = []
  for (const v of VERBS) {
    const spelling = v.words.find((w) => w.startsWith(f)) ?? (f === '' ? verbLabel(v) : undefined)
    if (spelling) out.push({ kind: 'verb', label: spelling, insert: spelling, detail: trNow(v.hint) })
  }
  if (f === '' || 'repeat'.startsWith(f) || f === '!' || f === '!!') out.push({ kind: 'repeat', label: '!!', insert: '!!', detail: trNow('Repeat the last command') })
  return out
}

function valueIsComplete(verb: VerbId, text: string, ctx: ResolveContext): boolean {
  switch (verb) {
    case 'priority': case 'points': return true
    case 'assign': return !isError(resolveUser(text, ctx))
    case 'status': {
      const names = (ctx.transitions?.transitions ?? []).flatMap((t) => [t.to.name, t.name])
      const m = matchName([...new Set(names)], text, (n) => [n])
      return m.kind === 'one'
    }
    case 'sprint': return text.toLowerCase() === 'backlog' || matchName(ctx.sprints ?? [], text, (x) => [x.name]).kind === 'one'
    case 'due': return parseRelativeDate(text, ctx.now) !== null || text.toLowerCase() === 'none'
    default: return false
  }
}

/**
 * Suggestions for the word being typed at the end of `input`. Verbs first; after a verb, its arguments from live data.
 * Nothing is suggested inside a comment.
 */
export function completeCommand(input: string, ctx: ResolveContext): Completion {
  const tk = tokenize(input)
  const none = (from: number, fragment = ''): Completion => ({ from, fragment, suggestions: [], expecting: null })
  if (tk.comment !== null) return none(input.length)

  // The fragment is the last token unless the input ends in whitespace (then a new, empty word starts).
  const endsOpen = !isSpace(input[input.length - 1]) && input.length > 0
  let tokens = tk.tokens
  let fragment = ''
  let from = input.length
  if (endsOpen && tokens.length > 0) {
    const last = tokens[tokens.length - 1]
    fragment = last.text
    from = last.start
    tokens = tokens.slice(0, -1)
  } else if (tk.unterminated && tokens.length > 0) {
    const last = tokens[tokens.length - 1]
    fragment = last.text; from = last.start; tokens = tokens.slice(0, -1)
  }

  // find the clause the fragment belongs to
  let verb: VerbSpec | null = null
  let valueTokens: Token[] = []
  for (let i = 0; i < tokens.length;) {
    const v = verbAt(tokens, i)
    if (v) { verb = v.spec; valueTokens = []; i += v.words } else { if (verb) valueTokens.push(tokens[i]); i++ }
  }
  // a fragment that is the beginning of a multi-word verb ("fix" for "fix version") continues the verb
  const lastWord = tokens.length > 0 ? tokens[tokens.length - 1] : null
  if (lastWord && !lastWord.quoted && lastWord.text.toLowerCase() === 'fix' && 'version'.startsWith(fragment.toLowerCase()) && (verb === null || valueTokens.length === 0)) {
    return { from, fragment, suggestions: [{ kind: 'verb', label: 'version', insert: 'version', detail: trNow('Add, remove or replace the fix version') }], expecting: 'version' }
  }

  const quoted = (s: string) => quoteIfNeeded(s)
  const finish = (suggestions: Suggestion[], expecting: string | null): Completion => ({ from, fragment, suggestions: suggestions.slice(0, MAX_SUGGESTIONS), expecting })

  if (!verb) {
    const wantsVerb = verbSuggestions(fragment)
    return finish(wantsVerb, 'a command')
  }

  // A value that already resolves to exactly one thing is complete: the next word may start a new verb.
  const done = valueTokens.length > 0 && valueIsComplete(verb.id, valueTokens.map((t) => t.text).join(' '), ctx)
  if (fragment === '' && done) return finish(verbSuggestions(''), 'another command')
  if (verb.bare) return finish(verbSuggestions(fragment), 'another command')

  const withVerbs = (args: Suggestion[], expecting: string): Completion => {
    const ranked = rank(args, fragment)
    if (done && fragment !== '') {
      const verbs = verbSuggestions(fragment).filter((v) => v.kind === 'verb' || v.kind === 'repeat')
      if (verbs.length > 0) return finish([...verbs, ...ranked], 'another command or a value')
    }
    if (ranked.length > 0) return finish(ranked, expecting)
    return finish(valueTokens.length > 0 || fragment !== '' ? verbSuggestions(fragment) : [], valueTokens.length > 0 ? 'another command' : expecting)
  }

  switch (verb.id) {
    case 'assign': {
      const list: Suggestion[] = [
        { kind: 'user', label: 'me', insert: 'me', detail: ctx.me ? ctx.me.displayName : undefined },
        { kind: 'user', label: 'none', insert: 'none', detail: trNow('Remove the assignee') },
        ...ctx.users.map((u): Suggestion => ({ kind: 'user', label: u.displayName || u.name || String(u.id), insert: quoted(u.displayName || u.name || String(u.id)), detail: u.name && u.name !== u.displayName ? `@${u.name}` : u.email })),
      ]
      return withVerbs(list, 'a user')
    }
    case 'status': {
      const data = ctx.transitions
      if (!data) return finish([], 'a status (loading)')
      const seen = new Set<string>()
      const list: Suggestion[] = []
      const common = new Set(data.commonIds)
      for (const t of [...data.transitions].sort((a, b) => Number(common.has(b.id)) - Number(common.has(a.id)) || b.count - a.count)) {
        if (seen.has(t.to.name)) continue
        seen.add(t.to.name)
        const all = data.transitions.filter((x) => x.to.name === t.to.name).some((x) => common.has(x.id))
        list.push({ kind: 'status', label: t.to.name, insert: quoted(t.to.name), detail: all ? (data.total === 1 ? trNow('this issue') : trNow('all {n} issues', { n: data.total })) : trNow('only {count} of {total} issues', { count: t.count, total: data.total }) })
      }
      return withVerbs(list, 'a status')
    }
    case 'priority':
      return withVerbs(ctx.priorities.map((p) => ({ kind: 'priority' as const, label: p.name, insert: quoted(p.name) })), 'a priority')
    case 'label': {
      const labelSug: Suggestion[] = ctx.labels.map((l) => ({ kind: 'label' as const, label: l, insert: l }))
      if (valueTokens.length === 0) {
        const modes = MODE_WORDS.map((m): Suggestion => ({ kind: 'mode', label: m, insert: m, detail: m === 'add' ? trNow('Add to existing labels') : m === 'remove' ? trNow('Remove from existing labels') : trNow('Replace all labels') }))
        return withVerbs([...modes, ...labelSug], 'add, remove or a label')
      }
      return withVerbs(labelSug, 'a label')
    }
    case 'sprint': {
      const list: Suggestion[] = [{ kind: 'sprint', label: 'backlog', insert: 'backlog', detail: trNow('Remove from the sprint') }, ...(ctx.sprints ?? []).map((s): Suggestion => ({ kind: 'sprint', label: s.name, insert: quoted(s.name), detail: s.state === 'active' ? trNow('active') : undefined }))]
      return withVerbs(list, 'a sprint')
    }
    case 'fixVersion': {
      const vs: Suggestion[] = (ctx.versions ?? []).map((v) => ({ kind: 'version' as const, label: v.name, insert: quoted(v.name) }))
      if (valueTokens.length === 0 && !(tokens.length > 0 && MODE_WORDS.includes(tokens[tokens.length - 1].text.toLowerCase() as ListMode))) {
        return withVerbs([...MODE_WORDS.map((m): Suggestion => ({ kind: 'mode', label: m, insert: m })), ...vs], 'add, remove or a version')
      }
      return withVerbs(vs, 'a version')
    }
    case 'due': {
      const d = (label: string, detail?: string): Suggestion => ({ kind: 'date', label, insert: label, detail: detail ?? (parseRelativeDate(label, ctx.now) ? formatDateLong(parseRelativeDate(label, ctx.now)!) : undefined) })
      return withVerbs([d('today'), d('tomorrow'), d('+3d'), d('+1w'), d('next monday'), d('next friday'), d('next week'), d('end of month'), d('none', trNow('Clear the due date'))], 'a date')
    }
    case 'points':
      return withVerbs(['1', '2', '3', '5', '8', '13', 'none'].map((n) => ({ kind: 'number' as const, label: n, insert: n })), 'a number')
    default:
      return finish(verbSuggestions(fragment), 'a command')
  }
}

/** Input after choosing a suggestion: the fragment is replaced and a space is appended so the next word can follow. */
export function applySuggestion(input: string, completion: Completion, s: Suggestion): string {
  return `${input.slice(0, completion.from)}${s.insert} `
}

/* ------------------------------------------------------------------ */
/*  Last command (repeat)                                              */
/* ------------------------------------------------------------------ */

export const LAST_COMMAND_KEY = 'veqsio:cmdline:v1:history'
const HISTORY_MAX = 20

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function loadCommandHistory(storage: StorageLike | null): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(LAST_COMMAND_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX) : []
  } catch { return [] }
}

/** Newest first, no duplicates, `!!` and empty lines are never stored. */
export function pushCommandHistory(storage: StorageLike | null, command: string): string[] {
  const c = command.trim()
  if (!storage || c === '' || isRepeatCommand(c)) return loadCommandHistory(storage)
  const next = [c, ...loadCommandHistory(storage).filter((x) => x !== c)].slice(0, HISTORY_MAX)
  try { storage.setItem(LAST_COMMAND_KEY, JSON.stringify(next)) } catch { /* storage unavailable or full */ }
  return next
}

export const lastCommand = (storage: StorageLike | null): string | null => loadCommandHistory(storage)[0] ?? null
