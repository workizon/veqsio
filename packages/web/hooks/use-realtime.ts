'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { getRealtimeClient, type ChannelHandler, type PresenceUser, type RealtimeEventPayload, type RealtimeStatus, type ServerMessage } from '@/lib/realtime'
import { toast } from '@/components/toast'

/** Subscribe to one or more channels; `handler` always sees the latest closure. */
export function useRealtimeChannel(channel: string | string[] | null | undefined, handler: ChannelHandler) {
  const ref = useRef(handler)
  ref.current = handler
  const channels = Array.isArray(channel) ? channel : channel ? [channel] : []
  const dep = channels.join('|')
  useEffect(() => {
    if (!dep) return
    const client = getRealtimeClient()
    const offs = dep.split('|').map((c) => client.subscribe(c, (m) => ref.current(m)))
    return () => offs.forEach((off) => off())
  }, [dep])
}

export function useRealtimeStatus(): RealtimeStatus {
  const client = getRealtimeClient()
  return useSyncExternalStore(
    (cb) => client.onStatus(cb),
    () => client.status,
    () => 'idle' as RealtimeStatus
  )
}

interface LiveOptions {
  /** Query keys (prefix match) to invalidate when somebody else changes something. */
  queryKeys: QueryKey[]
  /** Optional filter for events that should trigger a refetch. */
  filter?: (e: RealtimeEventPayload) => boolean
  /** Show a subtle "updated by X" toast for other people's changes. */
  toastOthers?: boolean
  debounceMs?: number
}

/**
 * Invalidate React Query caches on realtime events. Debounced (300 ms) to avoid refetch storms and
 * ignores events caused by the current user (their mutations already invalidate the cache).
 */
export function useLiveInvalidation(channel: string | string[] | null | undefined, opts: LiveOptions) {
  const qc = useQueryClient()
  const optsRef = useRef(opts)
  optsRef.current = opts
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastToast = useRef(0)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  useRealtimeChannel(channel, (m: ServerMessage) => {
    if (m.type !== 'event') return
    const client = getRealtimeClient()
    const e = m.event
    if (e.actorId !== null && e.actorId === client.userId) return
    const o = optsRef.current
    if (o.filter && !o.filter(e)) return
    if (o.toastOthers && Date.now() - lastToast.current > 5000 && e.type !== 'comment.added') {
      lastToast.current = Date.now()
      const who = (e.actorId !== null && client.names.get(e.actorId)) || 'Someone'
      const what = e.type.startsWith('issue.') ? e.key : e.type === 'sprint.updated' ? 'a sprint' : 'the board'
      toast(`${what} updated by ${who}`, 'info')
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      for (const key of optsRef.current.queryKeys) qc.invalidateQueries({ queryKey: key })
    }, o.debounceMs ?? 300)
  })
}

/** Who else is viewing a channel (issue:/board:), without the current user. */
export function usePresence(channel: string | null | undefined): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([])
  useEffect(() => setUsers([]), [channel])
  useRealtimeChannel(channel, (m) => {
    if (m.type === 'presence') setUsers(m.users)
  })
  const me = getRealtimeClient().userId
  return users.filter((u) => u.id !== me)
}

/** Names of other people typing in an issue channel, plus a throttled `notifyTyping` sender. */
export function useTyping(channel: string | null | undefined) {
  const [typers, setTypers] = useState<Array<{ id: number; displayName: string }>>([])
  const last = useRef(0)
  useEffect(() => setTypers([]), [channel])
  useRealtimeChannel(channel, (m) => {
    if (m.type === 'typing') setTypers(m.users)
  })
  const notifyTyping = useCallback(() => {
    if (!channel) return
    const now = Date.now()
    if (now - last.current < 2500) return // server expires after 5 s
    last.current = now
    getRealtimeClient().send({ type: 'typing', channel })
  }, [channel])
  return { typers, notifyTyping }
}

export function typingLabel(typers: Array<{ displayName: string }>): string {
  if (typers.length === 0) return ''
  if (typers.length === 1) return `${typers[0].displayName} is typing…`
  if (typers.length === 2) return `${typers[0].displayName} and ${typers[1].displayName} are typing…`
  return `${typers[0].displayName} and ${typers.length - 1} others are typing…`
}
