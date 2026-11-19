/**
 * Keyboard model of the issue list as a pure reducer: a visible focus row, selection with Space and Shift+arrows,
 * and one expanded inline preview. The page owns the data; the reducer only needs the ordered ids.
 */

export type RowId = number

export interface ListNavState {
  /** Index of the focused row, -1 when nothing is focused yet. */
  focus: number
  /** Where a Shift+arrow range started. */
  anchor: number | null
  /** Selection as it was before the current Shift+arrow range began. */
  base: RowId[] | null
  selected: RowId[]
  /** Id of the row whose inline preview is open. */
  expanded: RowId | null
}

export const initialListNav: ListNavState = { focus: -1, anchor: null, base: null, selected: [], expanded: null }

export type ListNavAction =
  | { type: 'move'; delta: number; extend?: boolean }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'focus'; index: number }
  | { type: 'toggleSelect' }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'setSelection'; ids: RowId[] }
  | { type: 'selectAll' }
  | { type: 'reset' }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Drops ids that are no longer in the list and clamps the focus, after the data changed. */
export function reconcile(state: ListNavState, ids: RowId[]): ListNavState {
  const present = new Set(ids)
  const selected = state.selected.filter((id) => present.has(id))
  const expanded = state.expanded !== null && present.has(state.expanded) ? state.expanded : null
  const focus = ids.length === 0 ? -1 : state.focus >= ids.length ? ids.length - 1 : state.focus
  if (selected.length === state.selected.length && expanded === state.expanded && focus === state.focus) return state
  return { ...state, selected, expanded, focus, anchor: null, base: null }
}

export function listNavReducer(state: ListNavState, action: ListNavAction, ids: RowId[]): ListNavState {
  const n = ids.length
  switch (action.type) {
    case 'reset':
      return initialListNav
    case 'setSelection':
      return { ...state, selected: action.ids, anchor: null, base: null }
    case 'selectAll':
      return { ...state, selected: [...ids], anchor: null, base: null }
    case 'focus':
      return n === 0 ? state : { ...state, focus: clamp(action.index, 0, n - 1), anchor: null, base: null }
    case 'first':
      return n === 0 ? state : { ...state, focus: 0, anchor: null, base: null, expanded: moveExpanded(state, ids, 0) }
    case 'last':
      return n === 0 ? state : { ...state, focus: n - 1, anchor: null, base: null, expanded: moveExpanded(state, ids, n - 1) }
    case 'move': {
      if (n === 0) return state
      const from = state.focus < 0 ? (action.delta >= 0 ? -1 : n) : state.focus
      const to = clamp(from + action.delta, 0, n - 1)
      if (!action.extend) {
        return { ...state, focus: to, anchor: null, base: null, expanded: moveExpanded(state, ids, to) }
      }
      const anchor = state.anchor ?? (state.focus < 0 ? to : state.focus)
      const base = state.base ?? state.selected
      const lo = Math.min(anchor, to)
      const hi = Math.max(anchor, to)
      const range = ids.slice(lo, hi + 1)
      const merged = new Set([...base, ...range])
      // keep the order of the list for a stable selection array
      const selected = ids.filter((id) => merged.has(id))
      return { ...state, focus: to, anchor, base, selected, expanded: moveExpanded(state, ids, to) }
    }
    case 'toggleSelect': {
      if (state.focus < 0 || state.focus >= n) return state
      const id = ids[state.focus]
      const has = state.selected.includes(id)
      const selected = has ? state.selected.filter((s) => s !== id) : [...state.selected, id]
      return { ...state, selected, anchor: state.focus, base: null }
    }
    case 'expand': {
      if (state.focus < 0 || state.focus >= n) return state
      return { ...state, expanded: ids[state.focus] }
    }
    case 'collapse':
      return state.expanded === null ? state : { ...state, expanded: null }
  }
}

/** While a preview is open it follows the focus, like YouTrack's arrow-key preview. */
function moveExpanded(state: ListNavState, ids: RowId[], to: number): RowId | null {
  return state.expanded === null ? null : ids[to] ?? null
}

export function isSelected(state: ListNavState, id: RowId): boolean {
  return state.selected.includes(id)
}
