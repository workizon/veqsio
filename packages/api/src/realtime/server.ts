/**
 * WebSocket transport for real-time collaboration (Bun native WebSockets).
 *
 *   GET /ws            upgrade (cookie `session` or `?ticket=` from POST /rest/api/2/realtime/ticket)
 *
 * Client -> server JSON messages:
 *   {type:'subscribe',   channel}   channel = project:<id> | board:<id> | issue:<KEY-1>
 *   {type:'unsubscribe', channel}
 *   {type:'typing',      channel}   (issue channels only)
 *   {type:'ping'}
 *
 * Authorization: every subscribe resolves the project server-side and requires BROWSE_PROJECTS
 * (checkProjectPermission). Unknown, malformed and forbidden channels all yield the same generic error.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { parse as parseCookie } from 'hono/utils/cookie';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getSession } from '../auth/session';
import { checkProjectPermission } from '../middleware/permissions';
import { canSeeIssue } from '../security/issue-security';
import { issueDeskAccess } from '../servicedesk/service';
import { consumeTicket } from './tickets';
import { Hub, hub as defaultHub, LIMITS, RateLimiter, colorForUser, parseChannel, type PresenceUser } from './hub';

type User = typeof schema.users.$inferSelect;

export interface WsData {
  connId: string;
  userId: number;
  user: User;
  sessionId: string | null;
  rate: RateLimiter;
}

const GENERIC_SUBSCRIBE_ERROR = { type: 'error', code: 'subscribe_failed', message: 'Cannot subscribe to this channel' };

export function allowedOrigins(): string[] {
  const list = [process.env.WEB_URL || 'http://localhost:3001', ...(process.env.WS_ALLOWED_ORIGINS || '').split(',')];
  return list
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return s;
      }
    });
}

/** Browsers always send Origin on WebSocket handshakes; non-browser clients may omit it. */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  return allowedOrigins().includes(origin.replace(/\/+$/, ''));
}

export function toPresenceUser(u: User): PresenceUser {
  return { id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, color: colorForUser(u.id) };
}

async function loadUser(id: number): Promise<User | null> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u && u.active !== false ? u : null;
}

/** Resolve a channel to its project id SERVER-SIDE. Returns null for anything unknown. */
export async function resolveChannelProject(
  channel: string
): Promise<{ projectId: number; issueId?: number } | null> {
  const p = parseChannel(channel);
  if (!p) return null;
  if (p.kind === 'project') {
    const [r] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, p.id)).limit(1);
    return r ? { projectId: r.id } : null;
  }
  if (p.kind === 'board') {
    const [r] = await db.select({ projectId: schema.boards.projectId }).from(schema.boards).where(eq(schema.boards.id, p.id)).limit(1);
    return r?.projectId ? { projectId: r.projectId } : null;
  }
  const [r] = await db
    .select({ id: schema.issues.id, projectId: schema.issues.projectId })
    .from(schema.issues)
    .where(eq(schema.issues.issueKey, (p as { key: string }).key))
    .limit(1);
  return r ? { projectId: r.projectId, issueId: r.id } : null;
}

/** Full subscribe authorization. */
export async function authorizeSubscribe(user: User, channel: string): Promise<number | null> {
  const target = await resolveChannelProject(channel);
  if (!target) return null;
  if (!(await checkProjectPermission(user, target.projectId, 'BROWSE_PROJECTS'))) return null;
  if (target.issueId !== undefined) {
    if (!(await canSeeIssue(user.id, target.issueId))) return null; // issue security level
    // Service requests: only agents may watch an individual request (internal notes live there).
    const access = await issueDeskAccess(user, target.issueId);
    if (access.isRequest && !access.staff) return null;
  }
  return target.projectId;
}

export interface RealtimeOptions {
  hub?: Hub;
  /** Override the sweep/session-recheck interval (ms). */
  sweepIntervalMs?: number;
}

export function createRealtime(opts: RealtimeOptions = {}) {
  const hub = opts.hub ?? defaultHub;
  const sockets = new Map<string, ServerWebSocket<WsData>>();
  hub.setAuthorizer(async (userId, projectId) => {
    const u = await loadUser(userId);
    return !!u && (await checkProjectPermission(u, projectId, 'BROWSE_PROJECTS'));
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      try {
        hub.sweep();
        // Terminate sockets whose session was revoked (logout) without waiting for reconnects.
        for (const ws of sockets.values()) {
          if (ws.data.sessionId && !(await getSession(ws.data.sessionId))) ws.close(1008, 'session ended');
        }
      } catch {
        /* never crash the timer */
      }
    }, opts.sweepIntervalMs ?? 30_000);
    (timer as any).unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Returns null when the request is not for /ws, otherwise a Response (rejection) or undefined (upgraded). */
  async function handleUpgrade(req: Request, server: Server<WsData>): Promise<Response | undefined | null> {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') return null;
    if (req.method !== 'GET' || req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    if (!isOriginAllowed(req.headers.get('origin'))) return new Response('Forbidden', { status: 403 });

    let user: User | null = null;
    let sessionId: string | null = null;
    const cookieSession = parseCookie(req.headers.get('cookie') || '')['session'];
    if (cookieSession) {
      const s = await getSession(cookieSession);
      if (s) {
        user = await loadUser(s.userId);
        sessionId = user ? cookieSession : null;
      }
    }
    if (!user) {
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        const uid = await consumeTicket(ticket);
        if (uid !== null) user = await loadUser(uid);
      }
    }
    if (!user) return new Response('Unauthorized', { status: 401 });

    if (hub.connectionsForUser(user.id) >= LIMITS.maxConnectionsPerUser) {
      return new Response('Too many connections', { status: 429 });
    }

    const data: WsData = {
      connId: randomUUID(),
      userId: user.id,
      user,
      sessionId,
      rate: new RateLimiter(LIMITS.rateLimitMessages, LIMITS.rateLimitWindowMs),
    };
    return server.upgrade(req, { data }) ? undefined : new Response('Upgrade failed', { status: 400 });
  }

  const send = (ws: ServerWebSocket<WsData>, msg: object) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  };

  const websocket: WebSocketHandler<WsData> = {
    maxPayloadLength: LIMITS.maxMessageBytes,
    idleTimeout: 60,
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: true,
    open(ws) {
      sockets.set(ws.data.connId, ws);
      hub.addConnection({
        id: ws.data.connId,
        userId: ws.data.userId,
        user: toPresenceUser(ws.data.user),
        send: (d) => void ws.send(d),
        close: (c, r) => ws.close(c, r),
      });
      send(ws, { type: 'hello', userId: ws.data.userId });
    },
    async message(ws, raw) {
      const { connId } = ws.data;
      if (typeof raw !== 'string') return ws.close(1003, 'text only');
      if (Buffer.byteLength(raw) > LIMITS.maxMessageBytes) return ws.close(1009, 'message too big');
      if (!ws.data.rate.allow()) return ws.close(1008, 'rate limit exceeded');
      hub.touch(connId);

      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { type: 'error', code: 'bad_request', message: 'Invalid JSON' });
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return send(ws, { type: 'error', code: 'bad_request', message: 'Invalid message' });
      }

      switch (msg.type) {
        case 'ping':
          return send(ws, { type: 'pong' });
        case 'subscribe': {
          const channel = msg.channel;
          if (!parseChannel(channel)) return send(ws, { ...GENERIC_SUBSCRIBE_ERROR, channel: String(channel).slice(0, 64) });
          if (hub.isSubscribed(connId, channel)) return send(ws, { type: 'subscribed', channel });
          if (hub.subscriptionCount(connId) >= LIMITS.maxSubscriptions) {
            return send(ws, { type: 'error', code: 'too_many_subscriptions', channel, message: 'Subscription limit reached' });
          }
          let projectId: number | null = null;
          try {
            projectId = await authorizeSubscribe(ws.data.user, channel);
          } catch {
            projectId = null;
          }
          if (projectId === null) return send(ws, { ...GENERIC_SUBSCRIBE_ERROR, channel });
          // Socket may have closed while we were awaiting the DB.
          if (!sockets.has(connId)) return;
          const r = hub.subscribe(connId, channel, projectId);
          if (r === 'limit') return send(ws, { type: 'error', code: 'too_many_subscriptions', channel, message: 'Subscription limit reached' });
          send(ws, { type: 'subscribed', channel });
          return;
        }
        case 'unsubscribe':
          if (typeof msg.channel === 'string') hub.unsubscribe(connId, msg.channel);
          return send(ws, { type: 'unsubscribed', channel: msg.channel });
        case 'typing':
          if (typeof msg.channel === 'string') hub.typing(connId, msg.channel);
          return;
        default:
          return send(ws, { type: 'error', code: 'bad_request', message: 'Unknown message type' });
      }
    },
    close(ws) {
      sockets.delete(ws.data.connId);
      hub.removeConnection(ws.data.connId);
    },
  };

  return {
    hub,
    websocket,
    handleUpgrade,
    start,
    stop,
    /** fetch wrapper: WebSocket upgrade first, otherwise delegate (e.g. Hono's app.fetch). */
    wrapFetch(next: (req: Request) => Response | Promise<Response>) {
      return async (req: Request, server: Server<WsData>) => {
        const r = await handleUpgrade(req, server);
        return r === null ? next(req) : (r as Response);
      };
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

/** Create a Bun server that serves `fetch` plus the realtime WebSocket endpoint. */
export function createServer(opts: { port: number; fetch: (req: Request) => Response | Promise<Response>; realtime?: Realtime }) {
  const realtime = opts.realtime ?? createRealtime();
  const server = Bun.serve<WsData>({
    port: opts.port,
    fetch: realtime.wrapFetch(opts.fetch),
    websocket: realtime.websocket,
  });
  realtime.start();
  return { server, realtime };
}
