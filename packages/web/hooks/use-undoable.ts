'use client'

import { useCallback } from 'react'
import { UndoController, type UndoableAction } from '@/lib/undoable'
import { UndoKeyStack, shouldUndoOnKey } from '@/lib/undo-stack'
import { isTypingTarget } from '@/lib/shortcuts'
import { undoToast, toast, dismissToast } from '@/components/toast'

/**
 * One controller for the whole app so an undo window survives client-side navigation. When the tab is
 * closed or reloaded, pending deferred commits are flushed (committed) rather than silently dropped.
 */
let controller: UndoController | null = null
const keyStack = new UndoKeyStack()
let keyListenerInstalled = false

/** Ctrl/Cmd+Z undoes the newest open undo toast (not while typing in a field, where the browser's own undo applies). */
function installUndoKey() {
  if (keyListenerInstalled || typeof window === 'undefined') return
  keyListenerInstalled = true
  window.addEventListener('keydown', (e) => {
    if (!shouldUndoOnKey(e, isTypingTarget(e.target), keyStack.size)) return
    if (keyStack.undoLatest()) e.preventDefault()
  })
}

export function getUndoController(): UndoController {
  if (!controller) {
    controller = new UndoController()
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => { void controller?.flushAll() })
    }
  }
  return controller
}

export interface UndoableRun extends UndoableAction {
  /** Toast action label, default "Undo". */
  undoLabel?: string
}

/** Undo window of the reversible-edit toasts (long enough to read, hover and press Ctrl/Cmd+Z). */
export const UNDOABLE_ACTION_MS = 9000

/**
 * Runs an operation with an undo toast. Ctrl/Cmd+Z also undoes it while the toast is visible.
 *
 *   const undoable = useUndoable()
 *   undoable({
 *     message: 'Issue VEQ-1 deleted',
 *     apply: () => hideRowOptimistically(),     // immediate UI change
 *     commit: () => api.delete(key),            // real call, after about 6 seconds unless undone
 *     revert: () => showRowAgain(),             // on Undo or if the commit fails
 *   })
 *
 * For edits that can be inverted, skip `commit` (do the call first) and pass `undo` instead.
 * Failures are reported with an error toast; `onError` and `onSettled` stay available.
 */
export function useUndoable() {
  return useCallback((run: UndoableRun) => {
    installUndoKey()
    const c = getUndoController()
    const userOnError = run.onError
    const userSettled = run.onSettled
    const id = c.start(
      {
        ...run,
        onError: (e, phase) => {
          toast(phase === 'undo' ? 'Could not undo that change' : (e instanceof Error && e.message) || 'That change could not be saved', 'error')
          userOnError?.(e, phase)
        },
        onSettled: (state) => {
          keyStack.remove(id)
          userSettled?.(state)
        },
      },
      { external: true },
    )
    const toastId = undoToast({
      message: run.message,
      actionLabel: run.undoLabel,
      duration: run.delayMs,
      onUndo: () => { void c.undo(id) },
      onExpire: () => { void c.expire(id) },
      onDismiss: () => { void c.dismiss(id) },
    })
    // Ctrl/Cmd+Z: undo and close the toast (closing it this way does not commit or dismiss anything else)
    keyStack.push(id, () => { void c.undo(id); dismissToast(toastId) })
    return id
  }, [])
}

/**
 * For edits that were ALREADY saved and can be reversed by a second call: the shared hook behind the undo toasts of
 * moves, status changes, assignee, priority, label and inline edits. Shows "message" with Undo (about 9 seconds,
 * Ctrl/Cmd+Z), runs `undo` when chosen. Offer it only when the reverse is known to work.
 *
 *   const undoableAction = useUndoableAction()
 *   undoableAction({ message: 'VEQ-1 moved to Done', undo: () => transitionBack() })
 */
export function useUndoableAction() {
  const undoable = useUndoable()
  return useCallback(
    (run: { message: string; undo: () => void | Promise<void>; undoLabel?: string; delayMs?: number; onSettled?: UndoableAction['onSettled'] }) =>
      undoable({ delayMs: UNDOABLE_ACTION_MS, ...run }),
    [undoable],
  )
}
