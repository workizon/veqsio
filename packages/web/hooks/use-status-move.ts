'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useUndoableAction } from '@/hooks/use-undoable'
import { toast } from '@/components/toast'
import type { ApiTransition } from '@/hooks/use-issues'
import { findReverseTransition } from '@/lib/undo-helpers'
import { planBoardMove, noRouteMessage } from '@/lib/board-move'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json().catch(() => undefined) as Promise<T>
}

const transitionsUrl = (key: string) => `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`
const post = (key: string, transitionId: number) =>
  api(transitionsUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transition: { id: transitionId } }) })

/**
 * After a plain status change, offers "Undo" (toast, 9 s, Ctrl/Cmd+Z) only when the workflow has a transition straight
 * back that needs no input and the move did not resolve the issue (see findReverseTransition). Otherwise a normal toast.
 * Returns the reverse transition it offered, or null.
 */
export function useOfferStatusUndo() {
  const undoableAction = useUndoableAction()
  const qc = useQueryClient()
  return useCallback(async (key: string, previousStatusName: string, moved: ApiTransition) => {
    let back: ApiTransition | null = null
    try {
      const fresh = await api<{ transitions: ApiTransition[] }>(transitionsUrl(key))
      back = findReverseTransition(fresh.transitions, previousStatusName, moved.to) as ApiTransition | null
    } catch { /* no undo offered when the transitions cannot be read */ }
    if (!back) { toast(`${key} moved to ${moved.to.name}`, 'success'); return null }
    const reverseId = back.id
    undoableAction({
      message: `${key} moved to ${moved.to.name}`,
      undo: async () => {
        await post(key, reverseId)
        toast(`${key} moved back to ${previousStatusName}`, 'success')
        for (const k of [['issue', key], ['issue', key, 'transitions'], ['issues', 'search'], ['board']]) void qc.invalidateQueries({ queryKey: k })
      },
    })
    return back
  }, [undoableAction, qc])
}

/**
 * Moves an issue to a status by running the transition that leads there (board drag). Optimistic: `optimistic()` shows
 * the move at once and returns the function that puts the old state back; it is called when no transition exists, the
 * transition needs input, or the server refuses. When the only way there needs input (for example a resolution), `onNeedsInput`
 * receives that transition so the caller can open the transition dialog; without it a toast explains. On success an Undo toast is
 * offered when the reverse transition exists.
 */
export function useMoveToStatus() {
  const qc = useQueryClient()
  const offerUndo = useOfferStatusUndo()
  return useCallback(async (args: { key: string; fromName: string; toStatusId: number; toName: string; optimistic?: () => () => void; onNeedsInput?: (t: ApiTransition) => void }): Promise<boolean> => {
    const rollback = args.optimistic?.() ?? (() => {})
    try {
      const { transitions } = await api<{ transitions: ApiTransition[] }>(transitionsUrl(args.key))
      const plan = planBoardMove(transitions, args.toStatusId)
      if (plan.kind === 'none') { rollback(); toast(noRouteMessage(args.key, args.fromName, args.toName, plan.reachable), 'warning'); return false }
      if (plan.kind === 'input') {
        rollback() // the card stays where it is until the dialog has been completed
        if (args.onNeedsInput) args.onNeedsInput(plan.transition)
        else toast(`Moving ${args.key} to ${args.toName} needs more input. Open the issue and use the status button.`, 'warning')
        return false
      }
      const t = plan.transition
      await post(args.key, t.id)
      void qc.invalidateQueries({ queryKey: ['issue', args.key] })
      void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
      await offerUndo(args.key, args.fromName, t)
      return true
    } catch (e: any) {
      rollback()
      toast(e?.message || `Could not move ${args.key}`, 'error')
      void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
      return false
    }
  }, [qc, offerUndo])
}
