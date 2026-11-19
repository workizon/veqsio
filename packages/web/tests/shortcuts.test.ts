import { describe, test, expect, beforeEach } from 'bun:test'
import {
  SHORTCUTS, ShortcutEngine, activeContexts, assertKnownHandlers, dispatchKey, eventComboId, findConflicts, formatSpec,
  helpSections, isTypingTarget, parseCombo, registerShortcuts, resetShortcutState, sequenceIds, validateTable,
  type ShortcutDef,
} from '../lib/shortcuts'

const body = { tagName: 'BODY' }
const ev = (key: string, extra: Record<string, unknown> = {}) => ({ key, target: body, ...extra })

describe('shortcut table', () => {
  test('is internally consistent', () => {
    expect(validateTable()).toEqual([])
  })

  test('has no conflicts between shortcuts that can be active together', () => {
    expect(findConflicts()).toEqual([])
  })

  test('conflict detection finds identical keys in one context and against global', () => {
    const defs: ShortcutDef[] = [
      { id: 'global.a', context: 'global', keys: ['c'], description: 'a' },
      { id: 'issueList.b', context: 'issueList', keys: ['c'], description: 'b' },
      { id: 'issueView.c', context: 'issueView', keys: ['c'], description: 'c' },
    ]
    const found = findConflicts(defs)
    expect(found.map((c) => [c.a, c.b])).toEqual([['global.a', 'issueList.b'], ['global.a', 'issueView.c']])
  })

  test('the same key in two page contexts is not a conflict', () => {
    const defs: ShortcutDef[] = [
      { id: 'issueList.e', context: 'issueList', keys: ['e'], description: 'x' },
      { id: 'issueView.e', context: 'issueView', keys: ['e'], description: 'y' },
    ]
    expect(findConflicts(defs)).toEqual([])
  })

  test('conflict detection catches a single key that starts a chord', () => {
    const defs: ShortcutDef[] = [
      { id: 'global.go', context: 'global', keys: ['g i'], description: 'x' },
      { id: 'issueList.g', context: 'issueList', keys: ['g'], description: 'y' },
    ]
    expect(findConflicts(defs)[0]).toMatchObject({ kind: 'prefix' })
  })

  test('validateTable reports bad ids and specs', () => {
    const problems = validateTable([
      { id: 'oops', context: 'global', keys: ['c'], description: '' },
      { id: 'global.x', context: 'global', keys: ['hyper+q'], description: '' },
      { id: 'global.x', context: 'global', keys: [], description: '' },
    ])
    expect(problems.length).toBe(4)
  })

  test('the keys the product promises are in the table', () => {
    const has = (id: string, key: string) => expect(SHORTCUTS.find((d) => d.id === id)?.keys).toContain(key)
    has('global.palette', 'mod+k')
    has('global.help', 'mod+/')
    has('global.help', '?')
    has('global.create', 'c')
    has('global.goIssues', 'g i')
    has('issueList.focusSearch', '/')
    has('issueList.toggleSelect', 'Space')
    has('issueList.expand', 'F3')
    has('issueList.edit', 'F2')
    for (const k of ['a', 'i', 'm', 'l', 'e', '.', '[', ']']) {
      expect(SHORTCUTS.some((d) => d.context === 'issueView' && d.keys.includes(k))).toBe(true)
    }
  })
})

describe('key specs', () => {
  test('parseCombo and ids', () => {
    expect(parseCombo('mod+k')).toEqual({ mod: true, alt: false, shift: false, key: 'k' })
    expect(sequenceIds('g i')).toEqual(['g', 'i'])
    expect(sequenceIds('shift+ArrowDown')).toEqual(['shift+ArrowDown'])
    expect(() => parseCombo('hyper+q')).toThrow()
  })

  test('eventComboId normalises ctrl/cmd, space and shifted symbols', () => {
    expect(eventComboId({ key: 'k', ctrlKey: true })).toBe('mod+k')
    expect(eventComboId({ key: 'K', metaKey: true, shiftKey: true })).toBe('mod+shift+k')
    expect(eventComboId({ key: ' ' })).toBe('Space')
    expect(eventComboId({ key: '?', shiftKey: true })).toBe('?')
    expect(eventComboId({ key: 'J', shiftKey: true })).toBe('shift+j')
    expect(eventComboId({ key: 'ArrowDown', shiftKey: true })).toBe('shift+ArrowDown')
  })

  test('isTypingTarget', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'textbox' : null) })).toBe(true)
    expect(isTypingTarget(body)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })

  test('formatSpec renders chords and modifiers', () => {
    expect(formatSpec('g i')).toEqual(['G', 'then', 'I'])
    expect(formatSpec('mod+k')).toEqual(['Ctrl', 'K'])
    expect(formatSpec('mod+k', true)).toEqual(['⌘', 'K'])
    expect(formatSpec('shift+ArrowDown')).toEqual(['Shift', '↓'])
    expect(formatSpec('Space')).toEqual(['Space'])
  })
})

describe('ShortcutEngine', () => {
  const contexts = ['issueView', 'global'] as const
  const resolve = (eng: ShortcutEngine, e: Record<string, unknown>, now = 0, extra: Record<string, unknown> = {}) =>
    eng.resolve(e as any, { contexts: [...contexts], ...extra }, now)

  test('single keys resolve in the active contexts only', () => {
    const eng = new ShortcutEngine()
    expect(resolve(eng, ev('a')).def?.id).toBe('issueView.assign')
    expect(resolve(eng, ev('c')).def?.id).toBe('global.create')
    // issue list keys are not active in the issue view
    expect(resolve(eng, ev('j')).def).toBeNull()
  })

  test('ignores typing in fields and modifier combos that belong to the browser', () => {
    const eng = new ShortcutEngine()
    expect(resolve(eng, { key: 'a', target: { tagName: 'TEXTAREA' } }).def).toBeNull()
    expect(resolve(eng, ev('a', { ctrlKey: true })).def).toBeNull()
    expect(resolve(eng, ev('c', { metaKey: true })).def).toBeNull()
    expect(resolve(eng, ev('a', { altKey: true })).def).toBeNull()
    expect(resolve(eng, ev('A', { shiftKey: true })).def).toBeNull()
    expect(resolve(eng, ev('a', { defaultPrevented: true })).def).toBeNull()
    expect(resolve(eng, ev('a', { isComposing: true })).def).toBeNull()
  })

  test('Ctrl+K and Ctrl+/ work while typing, plain keys do not', () => {
    const eng = new ShortcutEngine()
    const input = { tagName: 'INPUT' }
    expect(resolve(eng, { key: 'k', ctrlKey: true, target: input }).def?.id).toBe('global.palette')
    expect(resolve(eng, { key: '/', ctrlKey: true, target: input }).def?.id).toBe('global.help')
    expect(resolve(eng, { key: '?', shiftKey: true, target: input }).def).toBeNull()
    expect(resolve(eng, { key: '?', shiftKey: true, target: body }).def?.id).toBe('global.help')
  })

  test('g chords: second key completes, the issue-view "i" does not fire after g', () => {
    const eng = new ShortcutEngine()
    const first = resolve(eng, ev('g'), 1000)
    expect(first).toEqual({ def: null, consumed: true })
    expect(resolve(eng, ev('i'), 1200).def?.id).toBe('global.goIssues')
    // after the chord, a lone "i" is assign-to-me again
    expect(resolve(eng, ev('i'), 1300).def?.id).toBe('issueView.assignToMe')
  })

  test('chord times out', () => {
    const eng = new ShortcutEngine()
    resolve(eng, ev('g'), 1000)
    expect(resolve(eng, ev('i'), 5000).def?.id).toBe('issueView.assignToMe')
  })

  test('a broken chord does not swallow the next key', () => {
    const eng = new ShortcutEngine()
    resolve(eng, ev('g'), 0)
    expect(resolve(eng, ev('c'), 100).def?.id).toBe('global.create')
  })

  test('Space and Enter are left to focused buttons and links', () => {
    const eng = new ShortcutEngine()
    const list = { contexts: ['issueList' as const, 'global' as const] }
    expect(eng.resolve({ key: ' ', target: { tagName: 'BUTTON' } }, list, 0).def).toBeNull()
    expect(eng.resolve({ key: 'Enter', target: { tagName: 'A' } }, list, 0).def).toBeNull()
    expect(eng.resolve({ key: ' ', target: { tagName: 'DIV' } }, list, 0).def?.id).toBe('issueList.toggleSelect')
    expect(eng.resolve({ key: 'x', target: { tagName: 'BUTTON' } }, list, 0).def?.id).toBe('issueList.toggleSelect')
  })

  test('arrow keys and shift+arrows map to the list actions', () => {
    const eng = new ShortcutEngine()
    const o = { contexts: ['issueList' as const, 'global' as const] }
    expect(eng.resolve(ev('ArrowDown') as any, o, 0).def?.id).toBe('issueList.next')
    expect(eng.resolve(ev('ArrowDown', { shiftKey: true }) as any, o, 0).def?.id).toBe('issueList.extendDown')
    expect(eng.resolve(ev('F3') as any, o, 0).def?.id).toBe('issueList.expand')
    expect(eng.resolve(ev('Escape') as any, o, 0).def?.id).toBe('issueList.collapse')
  })

  test('blocked (a modal is open) only lets typing-safe shortcuts through', () => {
    const eng = new ShortcutEngine()
    expect(resolve(eng, ev('c'), 0, { blocked: true }).def).toBeNull()
    expect(resolve(eng, ev('k', { ctrlKey: true }), 0, { blocked: true }).def?.id).toBe('global.palette')
  })

  test('only shortcuts with a registered handler are offered (defs)', () => {
    const eng = new ShortcutEngine()
    const defs = SHORTCUTS.filter((d) => d.id === 'global.create')
    expect(eng.resolve(ev('c') as any, { defs, contexts: ['global'] }, 0).def?.id).toBe('global.create')
    expect(eng.resolve(ev('g') as any, { defs, contexts: ['global'] }, 0).consumed).toBe(false)
  })
})

describe('registry and dispatch', () => {
  beforeEach(() => resetShortcutState())

  test('dispatch runs the handler registered for the context', () => {
    const calls: string[] = []
    registerShortcuts('global', () => ({ 'global.create': () => { calls.push('create') } }))
    registerShortcuts('issueList', () => ({ 'issueList.next': () => { calls.push('next') } }))
    expect(dispatchKey(ev('c'), 0)).toBe(true)
    expect(dispatchKey(ev('j'), 1)).toBe(true)
    expect(calls).toEqual(['create', 'next'])
  })

  test('a handler returning false leaves the key alone', () => {
    registerShortcuts('issueList', () => ({ 'issueList.collapse': () => false }))
    expect(dispatchKey(ev('Escape'), 0)).toBe(false)
  })

  test('unregistering removes the context', () => {
    const off = registerShortcuts('issueView', () => ({ 'issueView.assign': () => {} }))
    expect(activeContexts()).toEqual(['issueView'])
    off()
    expect(activeContexts()).toEqual([])
    expect(dispatchKey(ev('a'), 0)).toBe(false)
  })

  test('specific contexts are listed before global', () => {
    registerShortcuts('global', () => ({}))
    registerShortcuts('issueList', () => ({}))
    expect(activeContexts()).toEqual(['issueList', 'global'])
  })

  test('handlers for unknown ids or the wrong context are rejected', () => {
    expect(() => assertKnownHandlers('global', { 'global.nope': () => {} })).toThrow()
    expect(() => assertKnownHandlers('global', { 'issueList.next': () => {} })).toThrow()
    expect(() => assertKnownHandlers('issueList', { 'issueList.next': () => {} })).not.toThrow()
  })

  test('a chord only starts when its second key has a handler', () => {
    registerShortcuts('global', () => ({ 'global.create': () => {} }))
    expect(dispatchKey(ev('g'), 0)).toBe(false)
  })
})

describe('help overlay data', () => {
  test('is generated from the table: every shortcut appears once, grouped by context', () => {
    const sections = helpSections()
    const rows = sections.flatMap((s) => s.rows)
    expect(rows.length).toBe(SHORTCUTS.length)
    expect(new Set(rows.map((r) => r.id)).size).toBe(SHORTCUTS.length)
    expect(sections.map((s) => s.context)).toEqual(['global', 'issueList', 'issueView', 'board'])
    const help = rows.find((r) => r.id === 'global.help')!
    expect(help.combos).toEqual([['Ctrl', '/'], ['?']])
  })
})
