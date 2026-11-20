import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface InboxItem { id: number; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }
export interface Inbox { unread: number; items: InboxItem[] }

const KEY = ['inbox']

async function load(): Promise<Inbox> {
  const res = await fetch('/rest/api/2/inbox', { credentials: 'include' })
  if (!res.ok) return { unread: 0, items: [] } // signed out or API unavailable: an empty bell, not an error
  return res.json()
}

/** The signed-in user's inbox (the header bell). Polled once a minute and refreshed when the tab regains focus. */
export function useInbox() {
  return useQuery({ queryKey: KEY, queryFn: load, refetchInterval: 60_000, retry: false })
}

/** Marks the given notifications read, or all of them when no ids are passed. Updates the list straight away. */
export function useMarkInboxRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids?: number[]) => {
      await fetch('/rest/api/2/inbox/read', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { ids } : {}) })
    },
    onMutate: (ids) => {
      qc.setQueryData<Inbox>(KEY, (old) => {
        if (!old) return old
        const items = old.items.map((i) => (!ids || ids.includes(i.id) ? { ...i, read: true } : i))
        return { items, unread: items.filter((i) => !i.read).length }
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
