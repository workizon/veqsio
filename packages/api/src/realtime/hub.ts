/**
 * Real-time pub/sub hub.
 *
 * Pure in-process registry (no DB, no sockets): connections are abstract objects with a `send`
 * function, so the hub is unit-testable. An optional `Bus` (Redis pub/sub) relays events, presence
 * snapshots and typing signals between API instances.
 *
 * Security properties enforced here:
 *  - every subscription records the SERVER-resolved projectId; delivery re-checks the connection's
 *    permission for that project through the injected `authorize` callback (cached with a short TTL),
 *    so a user who loses access stops receiving events within `permissionTtlMs`;
 *  - events are lightweight invalidations only (no bodies / field values);
 *  - presence only ever contains id, display name, avatar url and a color (never email).
 */
import { randomUUID } from 'crypto';

export type EventType =
  | 'issue.created'
  | 'issue.updated'
  | 'issue.deleted'
  | 'issue.transitioned'
  | 'comment.added'
  | 'sprint.updated'
  | 'board.updated';

export interface RealtimeEvent {
  type: EventType;
  /** Issue key for issue/comment events; the stringified id for sprint/board events. */
  key: string;
  projectId: number;
  actorId: number | null;
  at: string;
}

export interface PresenceUser {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  color: string;
}

export interface HubConn {
  id: string;
  userId: number;
  user: PresenceUser;
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface Bus {
  publish(message: string): void;
  onMessage(cb: (message: string) => void): void;
  close?(): void;
}

export type Authorizer = (userId: number, projectId: number) => Promise<boolean>;

export const LIMITS = {
  maxMessageBytes: 8 * 1024,
  maxSubscriptions: 50,
  maxConnectionsPerUser: 10,
  rateLimitMessages: 30,
  rateLimitWindowMs: 10_000,
  typingTtlMs: 5_000,
  presenceStaleMs: 75_000,
  remotePresenceTtlMs: 45_000,
  permissionTtlMs: 30_000,
} as const;

const COLORS = ['#DE350B', '#FF8B00', '#FFAB00', '#36B37E', '#00B8D9', '#0052CC', '#6554C0', '#C13584'];
export function colorForUser(id: number): string {
  return COLORS[Math.abs(id) % COLORS.length];
}

const CHANNEL_RE = /^(?:(project|board):(\d{1,10})|issue:([A-Za-z][A-Za-z0-9_]{0,30}-\d{1,10}))$/;
export type ParsedChannel =
  | { kind: 'project' | 'board'; id: number; channel: string }
  | { kind: 'issue'; key: string; channel: string };

export function parseChannel(channel: unknown): ParsedChannel | null {
  if (typeof channel !== 'string' || channel.length > 64) return null;
  const m = CHANNEL_RE.exec(channel);
  if (!m) return null;
  if (m[1]) return { kind: m[1] as 'project' | 'board', id: Number(m[2]), channel };
  return { kind: 'issue', key: m[3], channel };
}

/** Sliding-window rate limiter (per connection). */
export class RateLimiter {
  private hits: number[] = [];
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  /** Returns true when the action is allowed. */
  allow(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}

interface ConnState {
  conn: HubConn;
  /** channel -> server-resolved project id */
  subs: Map<string, number>;
  lastSeen: number;
  perm: Map<number, { ok: boolean; at: number }>;
}

interface RemotePresence {
  users: PresenceUser[];
  at: number;
}

export interface HubOptions {
  bus?: Bus;
  instanceId?: string;
  authorize?: Authorizer;
  now?: () => number;
  permissionTtlMs?: number;
  typingTtlMs?: number;
}

export class Hub {
  readonly instanceId: string;
  private conns = new Map<string, ConnState>();
  private byChannel = new Map<string, Set<string>>();
  /** project id -> board channels with at least one subscriber */
  private boardsByProject = new Map<number, Set<string>>();
  private remotePresence = new Map<string, Map<string, RemotePresence>>();
  private typingState = new Map<string, Map<number, { user: PresenceUser; timer: ReturnType<typeof setTimeout> }>>();
  private bus?: Bus;
  private authorize?: Authorizer;
  private now: () => number;
  private permissionTtlMs: number;
  private typingTtlMs: number;

  constructor(opts: HubOptions = {}) {
    this.instanceId = opts.instanceId ?? randomUUID();
    this.authorize = opts.authorize;
    this.now = opts.now ?? Date.now;
    this.permissionTtlMs = opts.permissionTtlMs ?? LIMITS.permissionTtlMs;
    this.typingTtlMs = opts.typingTtlMs ?? LIMITS.typingTtlMs;
    if (opts.bus) this.setBus(opts.bus);
  }

  setAuthorizer(fn: Authorizer | undefined) {
    this.authorize = fn;
  }

  setBus(bus: Bus | undefined) {
    this.bus = bus;
    bus?.onMessage((m) => this.onBusMessage(m));
  }

  /* -------------------------------- connections ------------------------------- */

  connectionCount(): number {
    return this.conns.size;
  }

  connectionsForUser(userId: number): number {
    let n = 0;
    for (const s of this.conns.values()) if (s.conn.userId === userId) n++;
    return n;
  }

  addConnection(conn: HubConn) {
    this.conns.set(conn.id, { conn, subs: new Map(), lastSeen: this.now(), perm: new Map() });
  }

  removeConnection(connId: string) {
    const st = this.conns.get(connId);
    if (!st) return;
    for (const channel of [...st.subs.keys()]) this.unsubscribe(connId, channel);
    this.conns.delete(connId);
  }

  touch(connId: string) {
    const st = this.conns.get(connId);
    if (st) st.lastSeen = this.now();
  }

  subscriptionCount(connId: string): number {
    return this.conns.get(connId)?.subs.size ?? 0;
  }

  isSubscribed(connId: string, channel: string): boolean {
    return !!this.conns.get(connId)?.subs.has(channel);
  }

  /* ------------------------------- subscriptions ------------------------------ */

  /**
   * Register a subscription. The caller MUST already have verified permission and resolved
   * `projectId` server-side. Returns 'limit' when the per-connection cap is reached.
   */
  subscribe(connId: string, channel: string, projectId: number): 'ok' | 'limit' | 'unknown' {
    const st = this.conns.get(connId);
    if (!st) return 'unknown';
    if (!st.subs.has(channel) && st.subs.size >= LIMITS.maxSubscriptions) return 'limit';
    st.subs.set(channel, projectId);
    st.perm.set(projectId, { ok: true, at: this.now() });
    let set = this.byChannel.get(channel);
    if (!set) this.byChannel.set(channel, (set = new Set()));
    set.add(connId);
    if (channel.startsWith('board:')) {
      let b = this.boardsByProject.get(projectId);
      if (!b) this.boardsByProject.set(projectId, (b = new Set()));
      b.add(channel);
    }
    if (hasPresence(channel)) this.presenceChanged(channel);
    return 'ok';
  }

  unsubscribe(connId: string, channel: string) {
    const st = this.conns.get(connId);
    if (!st || !st.subs.has(channel)) return;
    const projectId = st.subs.get(channel)!;
    st.subs.delete(channel);
    const set = this.byChannel.get(channel);
    if (set) {
      set.delete(connId);
      if (set.size === 0) {
        this.byChannel.delete(channel);
        if (channel.startsWith('board:')) {
          const b = this.boardsByProject.get(projectId);
          b?.delete(channel);
          if (b && b.size === 0) this.boardsByProject.delete(projectId);
        }
      }
    }
    if (hasPresence(channel)) this.presenceChanged(channel);
  }

  /* --------------------------------- publishing -------------------------------- */

  /** Publish an invalidation event to all instances (bus) or locally when there is no bus. */
  publish(event: RealtimeEvent) {
    if (this.bus) {
      try {
        this.bus.publish(JSON.stringify({ k: 'event', i: this.instanceId, event }));
        return;
      } catch {
        /* fall through to local delivery */
      }
    }
    this.deliverEvent(event);
  }

  /** Deliver an event to local subscribers only. */
  deliverEvent(event: RealtimeEvent) {
    const targets = new Map<string, string>(); // connId -> channel (deduped)
    const add = (channel: string) => {
      for (const id of this.byChannel.get(channel) ?? []) if (!targets.has(id)) targets.set(id, channel);
    };
    add(`project:${event.projectId}`);
    if (event.type.startsWith('issue.') || event.type === 'comment.added') add(`issue:${event.key}`);
    for (const boardChannel of this.boardsByProject.get(event.projectId) ?? []) add(boardChannel);
    const payload = { type: 'event', event };
    for (const [connId, channel] of targets) {
      const st = this.conns.get(connId);
      if (st) this.deliver(st, channel, { ...payload, channel });
    }
  }

  /** Cheap permission re-check on delivery with a per-connection TTL cache. */
  private deliver(st: ConnState, channel: string, message: object) {
    const projectId = st.subs.get(channel);
    if (projectId === undefined) return;
    const send = () => this.safeSend(st.conn, message);
    if (!this.authorize) return send();
    const cached = st.perm.get(projectId);
    const t = this.now();
    if (cached && t - cached.at < this.permissionTtlMs) {
      if (cached.ok) send();
      return;
    }
    this.authorize(st.conn.userId, projectId).then(
      (ok) => {
        st.perm.set(projectId, { ok, at: this.now() });
        if (ok) return send();
        this.revokeProject(st, projectId);
      },
      () => {
        /* fail closed: drop this message, keep state so the next delivery retries */
      }
    );
  }

  private revokeProject(st: ConnState, projectId: number) {
    for (const [channel, pid] of [...st.subs]) {
      if (pid === projectId) {
        this.unsubscribe(st.conn.id, channel);
        this.safeSend(st.conn, { type: 'unsubscribed', channel });
      }
    }
  }

  private safeSend(conn: HubConn, message: object) {
    try {
      conn.send(JSON.stringify(message));
    } catch {
      /* socket gone; close handler will clean up */
    }
  }

  /* ----------------------------------- presence ---------------------------------- */

  private localPresenceUsers(channel: string): PresenceUser[] {
    const out = new Map<number, PresenceUser>();
    for (const id of this.byChannel.get(channel) ?? []) {
      const st = this.conns.get(id);
      if (st) out.set(st.conn.userId, st.conn.user);
    }
    return [...out.values()];
  }

  /** Merged (local + non-expired remote) presence list for a channel. */
  getPresence(channel: string): PresenceUser[] {
    const out = new Map<number, PresenceUser>();
    for (const u of this.localPresenceUsers(channel)) out.set(u.id, u);
    const remote = this.remotePresence.get(channel);
    if (remote) {
      const t = this.now();
      for (const [inst, r] of remote) {
        if (t - r.at > LIMITS.remotePresenceTtlMs) remote.delete(inst);
        else for (const u of r.users) if (!out.has(u.id)) out.set(u.id, u);
      }
      if (remote.size === 0) this.remotePresence.delete(channel);
    }
    return [...out.values()].sort((a, b) => a.id - b.id);
  }

  private presenceChanged(channel: string) {
    this.broadcastPresence(channel);
    this.bus?.publish(
      JSON.stringify({ k: 'presence', i: this.instanceId, channel, users: this.localPresenceUsers(channel) })
    );
  }

  private broadcastPresence(channel: string) {
    const users = this.getPresence(channel);
    for (const id of this.byChannel.get(channel) ?? []) {
      const st = this.conns.get(id);
      if (st) this.safeSend(st.conn, { type: 'presence', channel, users });
    }
  }

  /** Periodic maintenance: drop stale connections, expire remote presence, re-announce local presence. */
  sweep() {
    const t = this.now();
    for (const st of [...this.conns.values()]) {
      if (t - st.lastSeen > LIMITS.presenceStaleMs) {
        try {
          st.conn.close(1001, 'idle');
        } catch {
          /* ignore */
        }
        this.removeConnection(st.conn.id);
      }
    }
    for (const [channel, remote] of [...this.remotePresence]) {
      let changed = false;
      for (const [inst, r] of remote) {
        if (t - r.at > LIMITS.remotePresenceTtlMs) {
          remote.delete(inst);
          changed = true;
        }
      }
      if (remote.size === 0) this.remotePresence.delete(channel);
      if (changed) this.broadcastPresence(channel);
    }
    if (this.bus) {
      for (const channel of this.byChannel.keys()) {
        if (hasPresence(channel)) {
          this.bus.publish(
            JSON.stringify({ k: 'presence', i: this.instanceId, channel, users: this.localPresenceUsers(channel) })
          );
        }
      }
    }
  }

  /* ------------------------------------ typing ----------------------------------- */

  /** A subscribed connection reports typing on an issue channel. Returns false if not allowed. */
  typing(connId: string, channel: string): boolean {
    const st = this.conns.get(connId);
    if (!st || !st.subs.has(channel) || !channel.startsWith('issue:')) return false;
    this.applyTyping(channel, st.conn.user);
    this.bus?.publish(JSON.stringify({ k: 'typing', i: this.instanceId, channel, user: st.conn.user }));
    return true;
  }

  private applyTyping(channel: string, user: PresenceUser) {
    let m = this.typingState.get(channel);
    if (!m) this.typingState.set(channel, (m = new Map()));
    const existing = m.get(user.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const mm = this.typingState.get(channel);
      if (mm?.get(user.id)?.timer === timer) {
        mm.delete(user.id);
        if (mm.size === 0) this.typingState.delete(channel);
        this.broadcastTyping(channel);
      }
    }, this.typingTtlMs);
    (timer as any).unref?.();
    m.set(user.id, { user, timer });
    if (!existing) this.broadcastTyping(channel);
  }

  getTyping(channel: string): PresenceUser[] {
    return [...(this.typingState.get(channel)?.values() ?? [])].map((e) => e.user);
  }

  private broadcastTyping(channel: string) {
    const typers = this.getTyping(channel);
    for (const id of this.byChannel.get(channel) ?? []) {
      const st = this.conns.get(id);
      if (!st) continue;
      // Never tell a user that they themselves are typing.
      const users = typers.filter((u) => u.id !== st.conn.userId).map((u) => ({ id: u.id, displayName: u.displayName }));
      this.safeSend(st.conn, { type: 'typing', channel, users });
    }
  }

  /* ------------------------------------- bus ------------------------------------ */

  private onBusMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.k === 'event' && msg.event) {
      this.deliverEvent(msg.event as RealtimeEvent);
    } else if (msg.k === 'presence' && msg.i !== this.instanceId && typeof msg.channel === 'string') {
      let remote = this.remotePresence.get(msg.channel);
      if (!remote) this.remotePresence.set(msg.channel, (remote = new Map()));
      if (Array.isArray(msg.users) && msg.users.length) {
        remote.set(msg.i, { users: msg.users.map(sanitizeUser).filter(Boolean) as PresenceUser[], at: this.now() });
      } else {
        remote.delete(msg.i);
      }
      this.broadcastPresence(msg.channel);
    } else if (msg.k === 'typing' && msg.i !== this.instanceId && typeof msg.channel === 'string') {
      const user = sanitizeUser(msg.user);
      if (user) this.applyTyping(msg.channel, user);
    }
  }
}

function sanitizeUser(u: any): PresenceUser | null {
  if (!u || typeof u.id !== 'number') return null;
  return {
    id: u.id,
    displayName: String(u.displayName ?? '').slice(0, 255),
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
    color: typeof u.color === 'string' ? u.color.slice(0, 16) : colorForUser(u.id),
  };
}

function hasPresence(channel: string) {
  return channel.startsWith('issue:') || channel.startsWith('board:');
}

/* ------------------------------ default singleton ------------------------------ */

export const hub = new Hub();

/**
 * Publish an invalidation event. Safe to call from request handlers: never throws and never blocks
 * the request (call it AFTER the database write succeeded).
 */
export function publish(
  type: EventType,
  data: { key: string | number; projectId: number; actorId?: number | null }
): void {
  try {
    hub.publish({
      type,
      key: String(data.key),
      projectId: data.projectId,
      actorId: data.actorId ?? null,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[realtime] publish failed:', (e as Error)?.message);
  }
}

const CHANNEL_NAME = 'veqsio:realtime';

/** Connect the singleton hub to Redis pub/sub so multiple API instances share events/presence. */
export async function startRedisFanout(url = process.env.REDIS_URL): Promise<(() => void) | null> {
  if (!url || url === 'memory:') return null;
  const { default: Redis } = await import('ioredis');
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const sub = new Redis(url);
  pub.on('error', () => {});
  sub.on('error', () => {});
  let handler: ((m: string) => void) | null = null;
  const bus: Bus = {
    publish(message) {
      pub.publish(CHANNEL_NAME, message).catch(() => {
        // Redis unavailable: degrade to instance-local delivery for events.
        try {
          const msg = JSON.parse(message);
          if (msg.k === 'event') hub.deliverEvent(msg.event);
        } catch {
          /* ignore */
        }
      });
    },
    onMessage(cb) {
      handler = cb;
    },
  };
  await sub.subscribe(CHANNEL_NAME);
  sub.on('message', (_ch: string, m: string) => handler?.(m));
  hub.setBus(bus);
  return () => {
    hub.setBus(undefined);
    pub.disconnect();
    sub.disconnect();
  };
}
