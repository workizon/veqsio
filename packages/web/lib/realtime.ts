/**
 * Singleton real-time client (WebSocket) for live boards, issues and backlog.
 *
 *  - connects directly to the API (`NEXT_PUBLIC_WS_URL`, else derived from `NEXT_PUBLIC_API_URL`,
 *    else same-origin `/ws` e.g. behind nginx); Next.js rewrites do not proxy WebSockets;
 *  - authenticates with a single-use ticket from POST /rest/api/2/realtime/ticket;
 *  - auto-reconnects with exponential backoff + jitter and re-subscribes all channels;
 *  - pauses (closes) when the tab has been hidden for a while, resumes on visibility;
 *  - no-op when WebSocket is unavailable (pages keep working with normal fetching).
 *
 * Messages never contain issue data: events are invalidation hints, clients refetch via the REST API.
 */

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'paused' | 'unsupported'

export interface RealtimeEventPayload {
  type: 'issue.created' | 'issue.updated' | 'issue.deleted' | 'issue.transitioned' | 'comment.added' | 'sprint.updated' | 'board.updated'
  key: string
  projectId: number
  actorId: number | null
  at: string
}

export interface PresenceUser {
  id: number
  displayName: string
  avatarUrl: string | null
  color: string
}

export type ServerMessage =
  | { type: 'hello'; userId: number }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'error'; code: string; channel?: string; message?: string }
  | { type: 'event'; channel: string; event: RealtimeEventPayload }
  | { type: 'presence'; channel: string; users: PresenceUser[] }
  | { type: 'typing'; channel: string; users: Array<{ id: number; displayName: string }> }
  | { type: 'pong' }

export type ChannelHandler = (msg: ServerMessage) => void

const HIDDEN_PAUSE_MS = 60_000
const PING_MS = 25_000
const DEAD_AFTER_MS = 75_000
const IDLE_CLOSE_MS = 10_000
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

export function getWsUrl(): string | null {
  if (typeof window === 'undefined') return null
  const explicit = process.env.NEXT_PUBLIC_WS_URL
  if (explicit) return explicit
  const api = process.env.NEXT_PUBLIC_API_URL
  if (api) {
    try {
      const u = new URL(api)
      return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/ws`
    } catch {
      /* fall through */
    }
  }
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
}

export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.round(cap / 2 + (rand() * cap) / 2) // "equal jitter"
}

class RealtimeClient {
  private ws: WebSocket | null = null
  private _status: RealtimeStatus = 'idle'
  private statusListeners = new Set<() => void>()
  private handlers = new Map<string, Set<ChannelHandler>>()
  private serverSubscribed = new Set<string>()
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastMessageAt = 0
  private wantConnection = false
  private listenersInstalled = false
  userId: number | null = null
  /** display names seen in presence lists, used for "updated by X" toasts */
  readonly names = new Map<number, string>()

  get status() {
    return this._status
  }

  private setStatus(s: RealtimeStatus) {
    if (this._status === s) return
    this._status = s
    this.statusListeners.forEach((l) => l())
  }

  onStatus(l: () => void) {
    this.statusListeners.add(l)
    return () => {
      this.statusListeners.delete(l)
    }
  }

  /** Subscribe a handler to a channel; returns an unsubscribe function. */
  subscribe(channel: string, handler: ChannelHandler): () => void {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      this.setStatus('unsupported')
      return () => {}
    }
    let set = this.handlers.get(channel)
    if (!set) this.handlers.set(channel, (set = new Set()))
    set.add(handler)
    this.wantConnection = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.installListeners()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.sendSubscribe(channel)
    else if (!this.ws && !this.reconnectTimer && this._status !== 'paused') this.connect()
    return () => {
      const s = this.handlers.get(channel)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) {
        this.handlers.delete(channel)
        if (this.serverSubscribed.delete(channel)) this.send({ type: 'unsubscribe', channel })
      }
      if (this.handlers.size === 0) this.scheduleIdleClose()
    }
  }

  send(msg: object): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  private sendSubscribe(channel: string) {
    if (this.serverSubscribed.has(channel)) return
    if (this.send({ type: 'subscribe', channel })) this.serverSubscribed.add(channel)
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.handlers.size === 0) {
        this.wantConnection = false
        this.teardown()
        this.setStatus('idle')
      }
    }, IDLE_CLOSE_MS)
  }

  private installListeners() {
    if (this.listenersInstalled || typeof document === 'undefined') return
    this.listenersInstalled = true
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
        this.hiddenTimer = setTimeout(() => {
          if (!document.hidden || !this.wantConnection) return
          this.teardown()
          this.setStatus('paused')
        }, HIDDEN_PAUSE_MS)
      } else {
        if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
        this.hiddenTimer = null
        if (this.wantConnection && !this.ws) {
          this.attempts = 0
          this.connect()
        }
      }
    })
    window.addEventListener('online', () => {
      if (this.wantConnection && !this.ws) {
        this.attempts = 0
        this.connect()
      }
    })
  }

  private teardown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    const ws = this.ws
    this.ws = null
    this.serverSubscribed.clear()
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close(1000)
      } catch {
        /* ignore */
      }
    }
  }

  private async connect() {
    const base = getWsUrl()
    if (!base || typeof WebSocket === 'undefined') return this.setStatus('unsupported')
    this.reconnectTimer = null
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting')
    let ticket: string | null = null
    try {
      const res = await fetch('/rest/api/2/realtime/ticket', { method: 'POST', credentials: 'include' })
      if (res.status === 401 || res.status === 403) {
        // Not logged in: nothing to connect to. Try again slowly (login may happen later).
        this.setStatus('disconnected')
        return this.scheduleReconnect(BACKOFF_MAX_MS)
      }
      if (!res.ok) throw new Error('ticket')
      ticket = (await res.json()).ticket
    } catch {
      return this.scheduleReconnect()
    }
    if (!this.wantConnection) return
    let ws: WebSocket
    try {
      ws = new WebSocket(`${base}?ticket=${encodeURIComponent(ticket!)}`)
    } catch {
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempts = 0
      this.lastMessageAt = Date.now()
      this.setStatus('connected')
      for (const channel of this.handlers.keys()) this.sendSubscribe(channel)
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) return ws.close()
        this.send({ type: 'ping' })
      }, PING_MS)
    }
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now()
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (msg.type === 'hello') this.userId = msg.userId
      if (msg.type === 'presence') msg.users.forEach((u) => this.names.set(u.id, u.displayName))
      if (msg.type === 'unsubscribed') this.serverSubscribed.delete(msg.channel)
      const channel = (msg as { channel?: string }).channel
      if (channel) this.handlers.get(channel)?.forEach((h) => safeCall(h, msg))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.serverSubscribed.clear()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      if (this.wantConnection && this._status !== 'paused') this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private scheduleReconnect(fixed?: number) {
    if (!this.wantConnection || this.reconnectTimer) return
    if (this._status !== 'disconnected') this.setStatus('reconnecting')
    const delay = fixed ?? backoffDelay(this.attempts++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (typeof document !== 'undefined' && document.hidden && this._status === 'paused') return
      void this.connect()
    }, delay)
  }
}

function safeCall(h: ChannelHandler, m: ServerMessage) {
  try {
    h(m)
  } catch (e) {
    console.error('[realtime] handler error', e)
  }
}

let instance: RealtimeClient | null = null
export function getRealtimeClient(): RealtimeClient {
  if (!instance) instance = new RealtimeClient()
  return instance
}
