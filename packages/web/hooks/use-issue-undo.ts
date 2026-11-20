'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useUndoable } from '@/hooks/use-undoable'
import { usePendingDeletes, commentPendingKey } from '@/hooks/pending-deletes'
import { trNow } from '@/lib/tr'

async function request(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { credentials: 'include', ...init })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
}

/**
 * Delete one or more issues behind an undo toast. The rows disappear at once; the real DELETE requests are
 * sent only when the toast expires (or is dismissed, or the tab closes), so Undo never has to re-create anything.
 * `keepalive` lets the request finish when the page is closing.
 */
export function useUndoableDeleteIssues() {
  const undoable = useUndoable()
  const qc = useQueryClient()
  return useCallback(
    (keys: string[], opts: { onApplied?: () => void; onUndone?: () => void } = {}) => {
      if (keys.length === 0) return
      const { add, remove } = usePendingDeletes.getState()
      undoable({
        message: keys.length === 1 ? `Issue ${keys[0]} deleted` : `${keys.length} issues deleted`,
        apply: () => {
          add(keys)
          opts.onApplied?.()
        },
        commit: async () => {
          const results = await Promise.allSettled(
            keys.map((k) => request(`/rest/api/2/issue/${encodeURIComponent(k)}`, { method: 'DELETE', keepalive: true })),
          )
          const failed = results.filter((r) => r.status === 'rejected')
          if (failed.length > 0) {
            throw new Error(failed.length === keys.length ? trNow('Could not delete the issues') : trNow('{failed} of {total} issues could not be deleted', { failed: failed.length, total: keys.length }))
          }
        },
        revert: () => {
          remove(keys)
          void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
          opts.onUndone?.()
        },
        onSettled: (state) => {
          if (state === 'committed') {
            remove(keys)
            void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
            for (const k of keys) qc.removeQueries({ queryKey: ['issue', k] })
          }
        },
      })
    },
    [undoable, qc],
  )
}

/** Comment delete behind an undo toast (same deferred-commit pattern). */
export function useUndoableDeleteComment() {
  const undoable = useUndoable()
  const qc = useQueryClient()
  return useCallback(
    (issueKey: string, commentId: string) => {
      const pk = commentPendingKey(issueKey, commentId)
      const { add, remove } = usePendingDeletes.getState()
      undoable({
        message: 'Comment deleted',
        apply: () => add([pk]),
        commit: () => request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${commentId}`, { method: 'DELETE', keepalive: true }),
        revert: () => remove([pk]),
        onSettled: () => {
          remove([pk])
          void qc.invalidateQueries({ queryKey: ['issue', issueKey, 'comments'] })
        },
      })
    },
    [undoable, qc],
  )
}
