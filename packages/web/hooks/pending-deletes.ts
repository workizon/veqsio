import { create } from 'zustand'

/**
 * Items whose DELETE is deferred behind an undo toast. They are hidden from lists immediately and shown
 * again if the user clicks Undo (or the delete fails). Keys are issue keys or `comment:<id>`.
 */
interface PendingDeletes {
  keys: Set<string>
  add: (keys: string[]) => void
  remove: (keys: string[]) => void
}

export const usePendingDeletes = create<PendingDeletes>((set) => ({
  keys: new Set(),
  add: (keys) => set((s) => ({ keys: new Set([...s.keys, ...keys]) })),
  remove: (keys) => set((s) => {
    const next = new Set(s.keys)
    for (const k of keys) next.delete(k)
    return { keys: next }
  }),
}))

export const commentPendingKey = (issueKey: string, commentId: string) => `comment:${issueKey}:${commentId}`
