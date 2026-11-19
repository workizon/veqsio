/**
 * Keyboard shortcuts: one table, one engine, one registry.
 *
 * The table below is the single source of truth. The real key handlers (via `useShortcuts`) and the help
 * overlay (Ctrl+/) both read it, so the help can never drift from behaviour. Everything in this file is
 * DOM-free and unit tested; the React glue lives in hooks/use-shortcuts.ts.
 *
 * Key spec syntax: space-separated chord of combos, each `[mod+][alt+][shift+]key`.
 *   `c`  `g i` (chord)  `mod+k` (Ctrl or Cmd)  `shift+ArrowDown`  `Space`  `F3`  `?`
 * Letters are written lower case. A shifted symbol is written as the symbol (`?`, not `shift+/`).
 */

export type ShortcutContext = 'global' | 'issueList' | 'issueView' | 'board'

export interface ShortcutDef {
  id: string
  context: ShortcutContext
  /** Alternative key specs for the same action. */
  keys: string[]
  description: string
  /** The `mod+` specs of this shortcut also fire while the user is typing in a field (Ctrl+K). Plain keys never do. */
  typing?: boolean
}

export const CONTEXT_LABELS: Record<ShortcutContext, string> = {
  global: 'Everywhere',
  issueList: 'Issue list',
  issueView: 'Issue view',
  board: 'Board',
}

export const CONTEXT_ORDER: ShortcutContext[] = ['global', 'issueList', 'issueView', 'board']

export const SHORTCUTS: ShortcutDef[] = [
  // Global
  { id: 'global.palette', context: 'global', keys: ['mod+k'], description: 'Open the command palette', typing: true },
  { id: 'global.help', context: 'global', keys: ['mod+/', '?'], description: 'Show keyboard shortcuts', typing: true },
  { id: 'global.commandLine', context: 'global', keys: ['mod+alt+j'], description: 'Command line for the selected issues', typing: true },
  { id: 'global.repeatCommand', context: 'global', keys: ['mod+shift+Enter'], description: 'Repeat the last command on the selected issues', typing: true },
  { id: 'global.create', context: 'global', keys: ['c'], description: 'Create issue' },
  { id: 'global.goIssues', context: 'global', keys: ['g i'], description: 'Go to issues' },
  { id: 'global.goDashboards', context: 'global', keys: ['g d'], description: 'Go to dashboards' },
  { id: 'global.goBoards', context: 'global', keys: ['g b'], description: 'Go to boards' },
  { id: 'global.goProjects', context: 'global', keys: ['g p'], description: 'Go to projects' },
  { id: 'global.createProject', context: 'global', keys: ['shift+c'], description: 'Create project' },
  { id: 'global.goAdmin', context: 'global', keys: ['g a'], description: 'Go to administration' },

  // Issue list
  { id: 'issueList.focusSearch', context: 'issueList', keys: ['/'], description: 'Focus the search box' },
  { id: 'issueList.next', context: 'issueList', keys: ['j', 'ArrowDown'], description: 'Next issue' },
  { id: 'issueList.prev', context: 'issueList', keys: ['k', 'ArrowUp'], description: 'Previous issue' },
  { id: 'issueList.first', context: 'issueList', keys: ['Home'], description: 'First issue' },
  { id: 'issueList.last', context: 'issueList', keys: ['End'], description: 'Last issue' },
  { id: 'issueList.extendDown', context: 'issueList', keys: ['shift+ArrowDown', 'shift+j'], description: 'Extend selection down' },
  { id: 'issueList.extendUp', context: 'issueList', keys: ['shift+ArrowUp', 'shift+k'], description: 'Extend selection up' },
  { id: 'issueList.toggleSelect', context: 'issueList', keys: ['Space', 'x'], description: 'Select or deselect the focused issue' },
  { id: 'issueList.open', context: 'issueList', keys: ['Enter', 'o'], description: 'Open the focused issue' },
  { id: 'issueList.peek', context: 'issueList', keys: ['p'], description: 'Peek at the focused issue in a side panel' },
  { id: 'issueList.expand', context: 'issueList', keys: ['ArrowRight', 'F3'], description: 'Expand the inline preview' },
  { id: 'issueList.collapse', context: 'issueList', keys: ['ArrowLeft', 'Escape'], description: 'Collapse the inline preview' },
  { id: 'issueList.bulk', context: 'issueList', keys: ['b'], description: 'Bulk change the selected issues' },
  { id: 'issueList.edit', context: 'issueList', keys: ['e', 'F2'], description: 'Edit the summary in place' },

  // Issue view
  { id: 'issueView.assign', context: 'issueView', keys: ['a'], description: 'Assign' },
  { id: 'issueView.assignToMe', context: 'issueView', keys: ['i'], description: 'Assign to me' },
  { id: 'issueView.comment', context: 'issueView', keys: ['m'], description: 'Add a comment' },
  { id: 'issueView.flag', context: 'issueView', keys: ['f'], description: 'Flag or unflag as an impediment' },
  { id: 'issueView.labels', context: 'issueView', keys: ['l'], description: 'Edit labels' },
  { id: 'issueView.editDescription', context: 'issueView', keys: ['e'], description: 'Edit the description' },
  { id: 'issueView.quickOps', context: 'issueView', keys: ['.'], description: 'Open quick operations' },
  { id: 'issueView.prev', context: 'issueView', keys: ['['], description: 'Previous issue in the list you came from' },
  { id: 'issueView.next', context: 'issueView', keys: [']'], description: 'Next issue in the list you came from' },

  // Board
  { id: 'board.focusSearch', context: 'board', keys: ['/'], description: 'Focus the card filter' },
]

/* ------------------------------------------------------------------ */
/*  Key specs                                                          */
/* ------------------------------------------------------------------ */

export interface Combo { mod: boolean; alt: boolean; shift: boolean; key: string }

export function parseCombo(spec: string): Combo {
  const parts = spec.split('+')
  // a literal "+" key is written "+" or "mod++"
  let key = parts.pop() as string
  if (key === '' && parts.length > 0) { key = '+'; parts.pop() }
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const known = new Set(['mod', 'alt', 'shift'])
  for (const m of mods) if (!known.has(m)) throw new Error(`Unknown modifier "${m}" in shortcut "${spec}"`)
  if (key === '') throw new Error(`Empty key in shortcut "${spec}"`)
  return { mod: mods.has('mod'), alt: mods.has('alt'), shift: mods.has('shift'), key: key.length === 1 ? key.toLowerCase() : key }
}

export function parseSequence(spec: string): Combo[] {
  const seq = spec.trim().split(/\s+/).map(parseCombo)
  if (seq.length === 0) throw new Error('Empty shortcut')
  return seq
}

export function comboId(c: Combo): string {
  return `${c.mod ? 'mod+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}${c.key}`
}

export function sequenceIds(spec: string): string[] {
  return parseSequence(spec).map(comboId)
}

export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  /** A DOM element or a plain object with the same fields (tests). */
  target?: unknown
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead'])

/** Normalised id of a keyboard event, comparable with `comboId(parseCombo(spec))`. */
export function eventComboId(e: KeyEventLike): string {
  let key = e.key === ' ' ? 'Space' : e.key
  const isLetter = key.length === 1 && key.toLowerCase() !== key.toUpperCase()
  const single = key.length === 1
  if (single) key = key.toLowerCase()
  // Shift is part of the character for symbols ("?", "{") and for upper-case letters we keep it explicit.
  const shift = !!e.shiftKey && (!single || isLetter)
  return comboId({ mod: !!(e.ctrlKey || e.metaKey), alt: !!e.altKey, shift, key })
}

/* ------------------------------------------------------------------ */
/*  Conflict detection                                                 */
/* ------------------------------------------------------------------ */

export interface Conflict { a: string; b: string; keys: string; kind: 'same' | 'prefix' }

/** Contexts that can be active at the same time: global is always active next to one page context. */
function overlap(a: ShortcutContext, b: ShortcutContext): boolean {
  return a === b || a === 'global' || b === 'global'
}

/**
 * Finds shortcuts that would fight over a key: identical sequences, or one being the start of a chord
 * (a single `g` and the chord `g i`). Only shortcuts whose contexts can be active together are compared.
 */
export function findConflicts(defs: ShortcutDef[] = SHORTCUTS): Conflict[] {
  const out: Conflict[] = []
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i]
      const b = defs[j]
      if (!overlap(a.context, b.context)) continue
      for (const ka of a.keys) {
        for (const kb of b.keys) {
          const sa = sequenceIds(ka)
          const sb = sequenceIds(kb)
          const n = Math.min(sa.length, sb.length)
          let same = true
          for (let k = 0; k < n; k++) if (sa[k] !== sb[k]) { same = false; break }
          if (!same) continue
          out.push({ a: a.id, b: b.id, keys: `${ka} / ${kb}`, kind: sa.length === sb.length ? 'same' : 'prefix' })
        }
      }
    }
  }
  return out
}

/** Problems with the table itself: duplicate ids, ids not prefixed by their context, unparsable specs. */
export function validateTable(defs: ShortcutDef[] = SHORTCUTS): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const d of defs) {
    if (ids.has(d.id)) problems.push(`duplicate id ${d.id}`)
    ids.add(d.id)
    if (!d.id.startsWith(d.context + '.')) problems.push(`${d.id} should start with "${d.context}."`)
    if (d.keys.length === 0) problems.push(`${d.id} has no keys`)
    for (const k of d.keys) {
      try { parseSequence(k) } catch (err) { problems.push(`${d.id}: ${(err as Error).message}`) }
    }
  }
  return problems
}

/* ------------------------------------------------------------------ */
/*  Targets                                                            */
/* ------------------------------------------------------------------ */

interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (n: string) => string | null
}

export function isTypingTarget(target: unknown): boolean {
  const t = (target || {}) as TargetLike
  const tag = (t.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true
  const role = t.getAttribute?.('role')
  return role === 'textbox' || role === 'combobox' || role === 'searchbox'
}

/** Elements that use Space and Enter themselves (activating a button or link). */
export function isActivatableTarget(target: unknown): boolean {
  const t = (target || {}) as TargetLike
  const tag = (t.tagName || '').toUpperCase()
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true
  const role = t.getAttribute?.('role')
  return role === 'button' || role === 'menuitem' || role === 'tab' || role === 'link' || role === 'checkbox' || role === 'switch'
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export const CHORD_TIMEOUT_MS = 1200

export interface ResolveOptions {
  /** Shortcuts the caller can actually run (has a handler). Defaults to all of them. */
  defs?: ShortcutDef[]
  /** Contexts currently active, most specific first. */
  contexts: ShortcutContext[]
  /** A modal is open: only shortcuts marked `typing` may fire. */
  blocked?: boolean
}

export interface Resolution {
  /** The shortcut to run, if a sequence completed. */
  def: ShortcutDef | null
  /** The key was used up (a completed shortcut or the start of a chord): the caller should preventDefault. */
  consumed: boolean
}

/** Stateful matcher for single keys and `g i`-style chords. */
export class ShortcutEngine {
  private pending: { ids: string[]; at: number } | null = null

  reset() { this.pending = null }

  get hasPendingChord(): boolean { return this.pending !== null }

  resolve(e: KeyEventLike, opts: ResolveOptions, now: number): Resolution {
    const none: Resolution = { def: null, consumed: false }
    if (e.defaultPrevented || e.isComposing) return none
    if (MODIFIER_KEYS.has(e.key)) return none

    const id = eventComboId(e)
    const typing = isTypingTarget(e.target)
    const activatable = isActivatableTarget(e.target)
    const defs = (opts.defs ?? SHORTCUTS).filter((d) => opts.contexts.includes(d.context))
    // While typing (or with a modal open) only `mod+` specs of shortcuts marked `typing` stay live.
    const restricted = typing || !!opts.blocked
    const live = (d: ShortcutDef, spec: string) => !restricted || (!!d.typing && spec.startsWith('mod+'))

    // Space and Enter belong to focused buttons and links.
    const blockedByTarget = activatable && (id === 'Space' || id === 'Enter')

    const order = (a: ShortcutDef, b: ShortcutDef) => opts.contexts.indexOf(a.context) - opts.contexts.indexOf(b.context)
    const sorted = [...defs].sort(order)

    const tryMatch = (prefix: string[]): { def: ShortcutDef | null; isPrefix: boolean } => {
      const want = [...prefix, id]
      let isPrefix = false
      for (const d of sorted) {
        for (const spec of d.keys) {
          if (!live(d, spec)) continue
          const seq = sequenceIds(spec)
          if (seq.length < want.length) continue
          if (!want.every((w, i) => seq[i] === w)) continue
          if (seq.length === want.length) return { def: d, isPrefix: false }
          isPrefix = true
        }
      }
      return { def: null, isPrefix }
    }

    const pending = this.pending && now - this.pending.at <= CHORD_TIMEOUT_MS ? this.pending : null
    this.pending = null

    if (pending) {
      const m = tryMatch(pending.ids)
      if (m.def) return { def: m.def, consumed: true }
      if (m.isPrefix) {
        this.pending = { ids: [...pending.ids, id], at: now }
        return { def: null, consumed: true }
      }
      // Chord broken: the key is evaluated afresh below, but never as the second key of the same chord.
    }

    if (blockedByTarget) return none
    const m = tryMatch([])
    if (m.def) return { def: m.def, consumed: true }
    if (m.isPrefix) {
      this.pending = { ids: [id], at: now }
      return { def: null, consumed: true }
    }
    return none
  }
}

/* ------------------------------------------------------------------ */
/*  Handler registry (DOM free)                                        */
/* ------------------------------------------------------------------ */

/** Return `false` to say "not applicable right now": the key then keeps its browser behaviour. */
export type ShortcutHandler = () => void | boolean

export type HandlerMap = Record<string, ShortcutHandler | undefined>

const registry = new Map<symbol, { context: ShortcutContext; handlers: () => HandlerMap }>()
const engine = new ShortcutEngine()

/** Throws when a handler targets an id that is not in the table for that context. */
export function assertKnownHandlers(context: ShortcutContext, handlers: HandlerMap, defs: ShortcutDef[] = SHORTCUTS) {
  for (const id of Object.keys(handlers)) {
    const def = defs.find((d) => d.id === id)
    if (!def) throw new Error(`No shortcut "${id}" in the shortcut table`)
    if (def.context !== context) throw new Error(`Shortcut "${id}" belongs to context "${def.context}", not "${context}"`)
  }
}

/** Registers handlers for a context; returns the unregister function. `getHandlers` is read on every key press. */
export function registerShortcuts(context: ShortcutContext, getHandlers: () => HandlerMap): () => void {
  const token = Symbol(context)
  registry.set(token, { context, handlers: getHandlers })
  return () => { registry.delete(token) }
}

export function activeContexts(): ShortcutContext[] {
  const set = new Set<ShortcutContext>()
  for (const r of registry.values()) set.add(r.context)
  return CONTEXT_ORDER.filter((c) => set.has(c)).sort((a, b) => (a === 'global' ? 1 : 0) - (b === 'global' ? 1 : 0))
}

function findHandler(def: ShortcutDef): ShortcutHandler | undefined {
  for (const r of registry.values()) {
    if (r.context !== def.context) continue
    const h = r.handlers()[def.id]
    if (h) return h
  }
  return undefined
}

/**
 * Feeds one keydown to the engine and runs the matching handler.
 * Returns true when the key was handled and the caller should preventDefault.
 */
export function dispatchKey(e: KeyEventLike, now: number, blocked = false): boolean {
  const contexts = activeContexts()
  if (contexts.length === 0) return false
  const runnable = SHORTCUTS.filter((d) => findHandler(d))
  const res = engine.resolve(e, { defs: runnable, contexts, blocked }, now)
  if (!res.def) return res.consumed
  const handler = findHandler(res.def)
  if (!handler) return false
  const r = handler()
  return r !== false
}

export function resetShortcutState() {
  engine.reset()
  registry.clear()
}

/* ------------------------------------------------------------------ */
/*  Help overlay data                                                  */
/* ------------------------------------------------------------------ */

export interface HelpRow { id: string; description: string; combos: string[][] }
export interface HelpSection { context: ShortcutContext; label: string; rows: HelpRow[] }

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Escape: 'Esc', Enter: 'Enter',
}

/** Human labels for one key spec, one entry per key cap. Chords are joined by the literal "then". */
export function formatSpec(spec: string, mac = false): string[] {
  const out: string[] = []
  spec.trim().split(/\s+/).forEach((part, i) => {
    if (i > 0) out.push('then')
    const c = parseCombo(part)
    if (c.mod) out.push(mac ? '⌘' : 'Ctrl')
    if (c.alt) out.push(mac ? '⌥' : 'Alt')
    if (c.shift) out.push(mac ? '⇧' : 'Shift')
    out.push(KEY_LABELS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key))
  })
  return out
}

/** The overlay content, generated from the same table the handlers use. */
export function helpSections(defs: ShortcutDef[] = SHORTCUTS, mac = false): HelpSection[] {
  return CONTEXT_ORDER.map((context) => ({
    context,
    label: CONTEXT_LABELS[context],
    rows: defs.filter((d) => d.context === context).map((d) => ({
      id: d.id,
      description: d.description,
      combos: d.keys.map((k) => formatSpec(k, mac)),
    })),
  })).filter((s) => s.rows.length > 0)
}
