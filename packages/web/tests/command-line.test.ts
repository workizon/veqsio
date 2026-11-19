import { describe, test, expect } from 'bun:test'
import {
  tokenize, parseCommand, parseRelativeDate, matchName, resolveInput, previewLine, completeCommand, applySuggestion,
  summarizeRun, emptyContext, isRepeatCommand, pushCommandHistory, lastCommand, loadCommandHistory, suggestVerb, type ResolveContext,
} from '../lib/command-line'
import type { BulkResult } from '../lib/bulk'

// Wednesday 11 November 2026
const NOW = new Date(2026, 10, 11, 10, 0, 0)

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  ...emptyContext(NOW),
  me: { id: 1, displayName: 'Admin User', name: 'admin' },
  users: [
    { id: 1, displayName: 'Admin User', name: 'admin', email: 'admin@x.io' },
    { id: 2, displayName: 'Ada Lovelace', name: 'ada', email: 'ada@x.io' },
    { id: 3, displayName: 'Adam Smith', name: 'adam', email: 'adam@x.io' },
    { id: 4, displayName: 'Grace Hopper', name: 'grace', email: 'grace@x.io' },
  ],
  priorities: [{ id: 1, name: 'Highest' }, { id: 2, name: 'High' }, { id: 3, name: 'Medium' }, { id: 4, name: 'Low' }],
  transitions: {
    total: 3,
    transitions: [
      { id: 11, name: 'Start progress', to: { id: 2, name: 'In Progress' }, count: 3 },
      { id: 12, name: 'Done', to: { id: 3, name: 'Done' }, count: 3 },
      { id: 13, name: 'Reopen', to: { id: 1, name: 'To Do' }, count: 1 },
    ],
    commonIds: [11, 12],
    unavailable: [],
  },
  labels: ['Bug', 'urgent'],
  sprints: [{ id: 5, name: 'Sprint 4', state: 'active' }, { id: 6, name: 'Sprint 5', state: 'future' }],
  versions: [{ id: 7, name: '1.2' }, { id: 8, name: '2.0' }],
  issueKeys: ['A-1', 'A-2', 'A-3'],
  projectKeys: ['A'],
  ...over,
})

describe('tokenize', () => {
  test('splits on whitespace and keeps quoted words together', () => {
    const t = tokenize(`status "In Progress" label 'a b'`)
    expect(t.tokens.map((x) => x.text)).toEqual(['status', 'In Progress', 'label', 'a b'])
    expect(t.tokens[1].quoted).toBe(true)
    expect(t.unterminated).toBe(false)
  })
  test('handles escaped quotes and apostrophes inside words', () => {
    expect(tokenize(String.raw`assign "Ada \"the\" Countess"`).tokens[1].text).toBe('Ada "the" Countess')
    expect(tokenize(`label it's`).tokens.map((x) => x.text)).toEqual(['label', "it's"])
  })
  test('reports an unterminated quote', () => {
    const t = tokenize('status "In Prog')
    expect(t.unterminated).toBe(true)
    expect(t.tokens[1].text).toBe('In Prog')
  })
  test('a colon followed by space (or at a word start) begins the comment', () => {
    expect(tokenize('status done: shipped it').comment).toBe('shipped it')
    expect(tokenize('status done : shipped it').comment).toBe('shipped it')
    expect(tokenize('status done :shipped').comment).toBe('shipped')
    expect(tokenize('status done: shipped it').tokens.map((x) => x.text)).toEqual(['status', 'done'])
  })
  test('--comment takes the rest; colons inside words stay', () => {
    const t = tokenize('priority high --comment urgent: really')
    expect(t.comment).toBe('urgent: really')
    expect(t.tokens.map((x) => x.text)).toEqual(['priority', 'high'])
    expect(tokenize('due 2026-12-24 label a:b').comment).toBeNull()
  })
  test('a colon inside quotes is not a comment marker', () => {
    expect(tokenize('label "a: b"').comment).toBeNull()
  })
  test('other options are collected', () => {
    expect(tokenize('watch --silent').options).toEqual(['--silent'])
  })
})

describe('parseCommand', () => {
  test('one clause with value', () => {
    const p = parseCommand('assign me')
    expect(p.errors).toEqual([])
    expect(p.clauses[0].verb).toBe('assign')
    expect(p.clauses[0].values.map((t) => t.text)).toEqual(['me'])
  })
  test('several clauses in one line, aliases and multi-word verbs', () => {
    const p = parseCommand('for ada state done fix version 1.2 tag add x')
    expect(p.errors).toEqual([])
    expect(p.clauses.map((c) => c.verb)).toEqual(['assign', 'status', 'fixVersion', 'label'])
    expect(p.clauses[3].mode).toBe('add')
  })
  test('multi-word values run to the next verb; quoted verbs stay values', () => {
    const p = parseCommand('status in progress priority high')
    expect(p.clauses[0].values.map((t) => t.text)).toEqual(['in', 'progress'])
    const q = parseCommand('status "for review"')
    expect(q.errors).toEqual([])
    expect(q.clauses[0].values[0].text).toBe('for review')
  })
  test('unknown verb gets a suggestion', () => {
    const p = parseCommand('assing me')
    expect(p.errors[0].code).toBe('unknown')
    expect(p.errors[0].message).toContain('assign')
    expect(suggestVerb('prio')).toBe('priority')
  })
  test('missing values and bare verbs with values are errors', () => {
    expect(parseCommand('assign').errors[0].code).toBe('missing')
    expect(parseCommand('watch now').errors[0].code).toBe('syntax')
    expect(parseCommand('label add').errors[0].code).toBe('missing')
    expect(parseCommand('label set').errors).toEqual([])
  })
  test('duplicate clauses and unknown options are errors', () => {
    expect(parseCommand('priority high priority low').errors.length).toBe(1)
    expect(parseCommand('label add a label add b').errors.length).toBe(1)
    expect(parseCommand('label add a label remove b').errors).toEqual([])
    expect(parseCommand('watch --silent').errors[0].message).toContain('--silent')
  })
  test('repeat words', () => {
    expect(isRepeatCommand(' !! ')).toBe(true)
    expect(parseCommand('repeat').repeat).toBe(true)
    expect(isRepeatCommand('status done')).toBe(false)
  })
  test('a comment alone is an error', () => {
    expect(parseCommand(': hello').errors[0].code).toBe('missing')
  })
})

describe('parseRelativeDate (today is Wed 2026-11-11)', () => {
  const d = (s: string) => parseRelativeDate(s, NOW)
  test('keywords', () => {
    expect(d('today')).toBe('2026-11-11')
    expect(d('tomorrow')).toBe('2026-11-12')
    expect(d('yesterday')).toBe('2026-11-10')
  })
  test('offsets', () => {
    expect(d('+3d')).toBe('2026-11-14')
    expect(d('3d')).toBe('2026-11-14')
    expect(d('+2w')).toBe('2026-11-25')
    expect(d('in 3 days')).toBe('2026-11-14')
    expect(d('in 2 weeks')).toBe('2026-11-25')
    expect(d('+1m')).toBe('2026-12-11')
    expect(d('-1d')).toBe('2026-11-10')
    expect(d('+60d')).toBe('2027-01-10')
  })
  test('weekdays: next occurrence, and next week variants', () => {
    expect(d('friday')).toBe('2026-11-13')
    expect(d('fri')).toBe('2026-11-13')
    expect(d('wednesday')).toBe('2026-11-18')
    expect(d('monday')).toBe('2026-11-16')
    expect(d('next friday')).toBe('2026-11-20')
    expect(d('next monday')).toBe('2026-11-16')
    expect(d('next week')).toBe('2026-11-16')
  })
  test('end of week / month, next month, month-end clamping', () => {
    expect(d('end of week')).toBe('2026-11-13')
    expect(d('eom')).toBe('2026-11-30')
    expect(d('next month')).toBe('2026-12-11')
    expect(parseRelativeDate('+1m', new Date(2026, 0, 31))).toBe('2026-02-28')
  })
  test('ISO dates are validated; garbage is null', () => {
    expect(d('2026-12-24')).toBe('2026-12-24')
    expect(d('2026-02-30')).toBeNull()
    expect(d('someday')).toBeNull()
    expect(d('')).toBeNull()
    expect(d('+99999d')).toBeNull()
  })
  test('crosses year end', () => {
    expect(parseRelativeDate('+3d', new Date(2026, 11, 30))).toBe('2027-01-02')
  })
})

describe('matchName', () => {
  const items = [{ n: 'Ada Lovelace' }, { n: 'Adam Smith' }, { n: 'Grace Hopper' }]
  test('exact beats prefix, prefix beats word and substring', () => {
    expect(matchName(items, 'ada lovelace', (i) => [i.n])).toEqual({ kind: 'one', item: items[0] })
    expect(matchName(items, 'grace', (i) => [i.n]).kind).toBe('one')
    expect(matchName(items, 'hopper', (i) => [i.n]).kind).toBe('one')
    expect(matchName(items, 'ovel', (i) => [i.n]).kind).toBe('one')
  })
  test('ambiguous and none', () => {
    expect(matchName(items, 'ad', (i) => [i.n]).kind).toBe('many')
    expect(matchName(items, 'zed', (i) => [i.n]).kind).toBe('none')
    expect(matchName(items, '  ', (i) => [i.n]).kind).toBe('none')
  })
})

describe('resolveCommand', () => {
  test('assign me / user / none, for alias', () => {
    expect(resolveInput('assign me', ctx()).operations[0]).toMatchObject({ operation: 'assign', params: { assigneeId: 1 }, undoable: true })
    expect(resolveInput('for grace', ctx()).operations[0].params).toEqual({ assigneeId: 4 })
    expect(resolveInput('assign "Ada Lovelace"', ctx()).operations[0].params).toEqual({ assigneeId: 2 })
    expect(resolveInput('assign none', ctx()).operations[0].params).toEqual({ assigneeId: null })
    expect(resolveInput('unassign', ctx()).operations[0].params).toEqual({ assigneeId: null })
  })
  test('ambiguous and unknown users', () => {
    const a = resolveInput('assign ad', ctx())
    expect(a.ok).toBe(false)
    expect(a.errors[0].code).toBe('ambiguous')
    expect(a.errors[0].message).toContain('Ada Lovelace')
    expect(a.operations).toEqual([])
    expect(resolveInput('assign zed', ctx()).errors[0].code).toBe('unknown')
  })
  test('me while the user is loading is pending, not an error screen', () => {
    const r = resolveInput('assign me', ctx({ me: null }))
    expect(r.pending).toBe(true)
    expect(r.ok).toBe(false)
  })
  test('status by target name or transition name, only common transitions', () => {
    expect(resolveInput('status done', ctx()).operations[0]).toMatchObject({ operation: 'transition', params: { transitionId: 12 }, undoable: false })
    expect(resolveInput('state "in progress"', ctx()).operations[0].params).toEqual({ transitionId: 11 })
    expect(resolveInput('status start', ctx()).operations[0].params).toEqual({ transitionId: 11 })
    const partial = resolveInput('status "to do"', ctx())
    expect(partial.errors[0].code).toBe('unavailable')
    expect(partial.errors[0].message).toContain('1 issue')
    expect(resolveInput('status nope', ctx()).errors[0].code).toBe('unknown')
  })
  test('status waits for transitions, reports none available, carries the comment', () => {
    expect(resolveInput('status done', ctx({ transitions: null })).pending).toBe(true)
    expect(resolveInput('status done', ctx({ transitions: { total: 2, transitions: [], commonIds: [], unavailable: [] } })).errors[0].code).toBe('unavailable')
    const r = resolveInput('status done : shipped', ctx())
    expect(r.operations[0].params).toEqual({ transitionId: 12, comment: 'shipped' })
    expect(r.comment).toBeNull()
  })
  test('transition that requires a comment', () => {
    const c = ctx()
    c.transitions!.transitions[1].requiresComment = true
    expect(resolveInput('status done', c).errors[0].code).toBe('missing')
    expect(resolveInput('status done: ok', c).ok).toBe(true)
  })
  test('priority', () => {
    expect(resolveInput('priority high', ctx()).operations[0].params).toEqual({ priorityId: 2 })
    expect(resolveInput('priority hi', ctx()).errors[0].code).toBe('ambiguous')
    expect(resolveInput('priority urgent', ctx()).errors[0].message).toContain('Available')
  })
  test('labels: modes, casing of known labels, invalid names', () => {
    expect(resolveInput('label add bug urgent', ctx()).operations[0].params).toEqual({ add: ['Bug', 'urgent'] })
    expect(resolveInput('label remove urgent', ctx()).operations[0].params).toEqual({ remove: ['urgent'] })
    expect(resolveInput('tag x', ctx()).operations[0].params).toEqual({ add: ['x'] })
    expect(resolveInput('label set a b', ctx()).operations[0].params).toEqual({ set: ['a', 'b'] })
    expect(resolveInput('label set', ctx()).operations[0].params).toEqual({ set: [] })
    expect(resolveInput('label add "a b"', ctx()).errors[0].code).toBe('invalid')
    expect(resolveInput('label remove ghost', ctx()).warnings.length).toBe(1)
  })
  test('sprint and fix version need one project', () => {
    expect(resolveInput('sprint "sprint 4"', ctx()).operations[0].params).toEqual({ sprintId: 5 })
    expect(resolveInput('sprint backlog', ctx()).operations[0].params).toEqual({ sprintId: null })
    expect(resolveInput('sprint 9', ctx()).errors[0].code).toBe('unknown')
    expect(resolveInput('sprint "sprint"', ctx()).errors[0].code).toBe('ambiguous')
    expect(resolveInput('sprint "Sprint 4"', ctx({ projectKeys: ['A', 'B'] })).errors[0].code).toBe('unavailable')
    expect(resolveInput('fix version 2.0', ctx()).operations[0].params).toEqual({ add: [8] })
    expect(resolveInput('fix version remove 1.2', ctx()).operations[0].params).toEqual({ remove: [7] })
    expect(resolveInput('fix version 9', ctx()).errors[0].code).toBe('unknown')
    expect(resolveInput('fixversion 2.0', ctx({ projectKeys: ['A', 'B'] })).errors[0].code).toBe('unavailable')
  })
  test('watch, unwatch are not undoable', () => {
    expect(resolveInput('watch', ctx()).operations[0]).toMatchObject({ operation: 'watch', undoable: false })
    expect(resolveInput('unwatch', ctx()).operations[0].operation).toBe('unwatch')
  })
  test('due and points merge into one edit operation', () => {
    const r = resolveInput('due tomorrow points 5', ctx())
    expect(r.operations.length).toBe(1)
    expect(r.operations[0]).toMatchObject({ operation: 'edit', params: { fields: { duedate: '2026-11-12', storyPoints: 5 } }, undoable: true })
    expect(resolveInput('due none', ctx()).operations[0].params).toEqual({ fields: { duedate: null } })
    expect(resolveInput('due blah', ctx()).errors[0].code).toBe('invalid')
    expect(resolveInput('points -2', ctx()).errors[0].code).toBe('invalid')
    expect(resolveInput('points 1.234', ctx()).errors[0].code).toBe('invalid')
    expect(resolveInput('points 2,5', ctx()).operations[0].params).toEqual({ fields: { storyPoints: 2.5 } })
  })
  test('undoable flags: all, some, none', () => {
    expect(resolveInput('assign me priority high', ctx()).undoable).toBe(true)
    const mixed = resolveInput('assign me status done', ctx())
    expect(mixed.undoable).toBe(false)
    expect(mixed.partlyUndoable).toBe(true)
    expect(resolveInput('watch', ctx()).partlyUndoable).toBe(false)
  })
  test('errors in any clause block all operations', () => {
    const r = resolveInput('assign me priority nope', ctx())
    expect(r.ok).toBe(false)
    expect(r.operations).toEqual([])
  })
  test('no selection', () => {
    expect(resolveInput('assign me', ctx({ issueKeys: [], projectKeys: [] })).errors[0].message).toContain('No issue is selected')
  })
  test('non-transition command keeps the comment for a separate post', () => {
    const r = resolveInput('priority high : see thread', ctx())
    expect(r.ok).toBe(true)
    expect(r.comment).toBe('see thread')
  })
  test('empty comment marker is an error', () => {
    expect(resolveInput('priority high :', ctx()).ok).toBe(false)
  })
})

describe('previewLine', () => {
  test('describes the plan', () => {
    expect(previewLine(resolveInput('status done', ctx()), 12)).toBe('Will set status to Done for 12 issues')
    expect(previewLine(resolveInput('assign me', ctx()), 1)).toBe('Will assign to you for 1 issue')
    expect(previewLine(resolveInput('assign ada priority high : hi', ctx()), 3)).toBe('Will assign to Ada Lovelace, set priority to High and add a comment for 3 issues')
    expect(previewLine(resolveInput('due next friday', ctx()), 2)).toBe('Will set the due date to Fri 20 Nov 2026 for 2 issues')
    expect(previewLine(resolveInput('', ctx()), 2)).toBe('')
  })
})

describe('completeCommand', () => {
  test('verbs at the start, filtered by the typed prefix', () => {
    const all = completeCommand('', ctx())
    expect(all.suggestions.map((s) => s.label)).toContain('assign')
    const c = completeCommand('pri', ctx())
    expect(c.suggestions.map((s) => s.label)).toEqual(['priority'])
    expect(c.from).toBe(0)
  })
  test('arguments by verb', () => {
    expect(completeCommand('assign ', ctx()).suggestions.map((s) => s.label).slice(0, 2)).toEqual(['me', 'none'])
    expect(completeCommand('assign gr', ctx()).suggestions[0].label).toBe('Grace Hopper')
    const st = completeCommand('status ', ctx())
    expect(st.suggestions.map((s) => s.label)).toEqual(['In Progress', 'Done', 'To Do'])
    expect(st.suggestions[2].detail).toBe('only 1 of 3 issues')
    expect(completeCommand('priority h', ctx()).suggestions.map((s) => s.label)).toEqual(['Highest', 'High'])
    expect(completeCommand('label ', ctx()).suggestions.map((s) => s.label).slice(0, 3)).toEqual(['add', 'remove', 'set'])
    expect(completeCommand('label add ', ctx()).suggestions.map((s) => s.label)).toEqual(['Bug', 'urgent'])
    expect(completeCommand('sprint ', ctx()).suggestions.map((s) => s.label)).toEqual(['backlog', 'Sprint 4', 'Sprint 5'])
    expect(completeCommand('fix version ', ctx()).suggestions.map((s) => s.label)).toContain('2.0')
    expect(completeCommand('due ', ctx()).suggestions[1]).toMatchObject({ label: 'tomorrow', detail: 'Thu 12 Nov 2026' })
    expect(completeCommand('points ', ctx()).suggestions.map((s) => s.label)).toContain('13')
  })
  test('after a resolved value a verb prefix beats name matches ("assign me pri")', () => {
    const c = completeCommand('assign me pri', ctx())
    expect(c.suggestions[0].label).toBe('priority')
    expect(c.from).toBe('assign me '.length)
    // an unresolved partial name keeps suggesting users
    expect(completeCommand('assign gr', ctx()).suggestions[0].kind).toBe('user')
    // a multi-word status being typed keeps suggesting statuses
    expect(completeCommand('status in pro', ctx()).suggestions[0].label).toBe('In Progress')
  })
  test('"fix" completes to "fix version"', () => {
    expect(completeCommand('fix', ctx()).suggestions.map((s) => s.label)).toContain('fix version')
    expect(completeCommand('fix v', ctx()).suggestions[0].label).toBe('version')
  })
  test('after a complete single value, verbs follow; nothing inside a comment', () => {
    expect(completeCommand('assign me ', ctx()).suggestions.map((s) => s.label)).toContain('priority')
    expect(completeCommand('status done : fo', ctx()).suggestions).toEqual([])
  })
  test('names with spaces are inserted quoted, and applied with a trailing space', () => {
    const input = 'status in'
    const c = completeCommand(input, ctx())
    expect(c.suggestions[0].insert).toBe('"In Progress"')
    expect(applySuggestion(input, c, c.suggestions[0])).toBe('status "In Progress" ')
  })
  test('statuses are empty while loading', () => {
    expect(completeCommand('status ', ctx({ transitions: null })).suggestions).toEqual([])
  })
  test('offers !! to repeat', () => {
    expect(completeCommand('!', ctx()).suggestions.map((s) => s.label)).toContain('!!')
  })
})

describe('summarizeRun', () => {
  const ok = (operation: BulkResult['operation'], keys: string[], failed: string[] = [], undo = false): BulkResult => ({
    operation, total: keys.length + failed.length, succeeded: keys, failed: failed.map((key) => ({ key, reason: 'No' })),
    ...(undo ? { undo: [{ operation, issueKeys: keys, params: { assigneeId: null } }] } : {}),
  })
  test('single operation, all ok, with undo', () => {
    const s = summarizeRun([ok('assign', ['A-1', 'A-2'], [], true)], 2)
    expect(s.tone).toBe('success')
    expect(s.headline).toBe('2 issues assigned.')
    expect(s.canUndo).toBe(true)
  })
  test('partial failure and total failure', () => {
    expect(summarizeRun([ok('priority', ['A-1'], ['A-2'])], 2).tone).toBe('warning')
    const bad = summarizeRun([ok('transition', [], ['A-1'])], 1)
    expect(bad.tone).toBe('error')
    expect(bad.headline).toContain('No issues were transitioned')
    expect(bad.canUndo).toBe(false)
  })
  test('several operations: undo newest first, only changed keys', () => {
    const s = summarizeRun([ok('assign', ['A-1', 'A-2'], [], true), ok('priority', ['A-1'], ['A-2'], true)], 2)
    expect(s.headline).toContain('1 of 2 changes')
    expect(s.undo.map((g) => g.operation)).toEqual(['priority', 'assign'])
    expect(s.failedKeys).toEqual(['A-2'])
  })
  test('comment failures are mentioned', () => {
    expect(summarizeRun([ok('assign', ['A-1'])], 1, { posted: 0, failed: 1 }).headline).toContain('1 comment could not be posted')
  })
})

describe('command history', () => {
  function store(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
  }
  test('newest first, deduplicated, repeat and blanks never stored', () => {
    const s = store()
    pushCommandHistory(s, 'status done')
    pushCommandHistory(s, 'assign me')
    pushCommandHistory(s, 'status done')
    pushCommandHistory(s, '!!')
    pushCommandHistory(s, '  ')
    expect(loadCommandHistory(s)).toEqual(['status done', 'assign me'])
    expect(lastCommand(s)).toBe('status done')
  })
  test('unavailable or broken storage never throws', () => {
    expect(lastCommand(null)).toBeNull()
    const broken = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(() => pushCommandHistory(broken, 'x')).not.toThrow()
    expect(loadCommandHistory({ getItem: () => 'not json', setItem: () => {} })).toEqual([])
  })
})
