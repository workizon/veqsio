/**
 * Which undo toast Ctrl/Cmd+Z applies to. Pure and DOM-free (tests/undo-stack.test.ts); hooks/use-undoable.ts owns
 * the single keydown listener and the shared instance.
 *
 * Rules: only the most recent still-open toast reacts, each press undoes one; the key is left alone while the user is
 * typing in a field (the browser's own text undo wins), with Shift (that is redo) or Alt held, or when no toast is open.
 */

export interface UndoStackEntry { id: number; undo: () => void }

export class UndoKeyStack {
  private entries: UndoStackEntry[] = []

  push(id: number, undo: () => void) {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.entries.push({ id, undo })
  }

  remove(id: number) { this.entries = this.entries.filter((e) => e.id !== id) }

  get size() { return this.entries.length }

  top(): UndoStackEntry | undefined { return this.entries[this.entries.length - 1] }

  /** Undoes the newest open entry. Returns true when something was undone. */
  undoLatest(): boolean {
    const e = this.entries.pop()
    if (!e) return false
    e.undo()
    return true
  }

  clear() { this.entries = [] }
}

export interface UndoKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
}

/** Ctrl/Cmd+Z without Shift or Alt. */
export function isUndoKey(e: UndoKeyEvent): boolean {
  return e.key.toLowerCase() === 'z' && !!(e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
}

/** Should this key press trigger the toast undo? `typing` is true when the target is an input, textarea or editable element. */
export function shouldUndoOnKey(e: UndoKeyEvent, typing: boolean, openToasts: number): boolean {
  if (openToasts <= 0 || typing || e.defaultPrevented || e.isComposing) return false
  return isUndoKey(e)
}
