import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { createServer } from '../../src/realtime/server';
import { LIMITS } from '../../src/realtime/hub';
import { redis } from '../../src/services/cache';

const ORIGIN = process.env.WEB_URL || 'http://localhost:3001';

interface Client {
  ws: WebSocket;
  msgs: any[];
  closed: Promise<{ code: number; reason: string }>;
  send(m: unknown): void;
  waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>;
  expectNone(pred: (m: any) => boolean, ms?: number): Promise<void>;
  close(): void;
}

describe('Realtime WebSocket (/ws)', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let handle: ReturnType<typeof createServer>;
  let base: string;
  let admin: string, viewer: string, outsider: string, customer: string;
  let viewerId: number, adminId: number;
  let issueKey: string;
  let requestKey: string;
  const clients: Client[] = [];

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };

  /** Opens a socket; resolves with the client, or null if the handshake was rejected. */
  function connect(opts: { cookie?: string; ticket?: string; origin?: string | null } = {}): Promise<Client | null> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
    const url = `${base}/ws${opts.ticket ? `?ticket=${opts.ticket}` : ''}`;
    const ws = new (WebSocket as any)(url, { headers }) as WebSocket;
    const msgs: any[] = [];
    const waiters: Array<() => void> = [];
    ws.addEventListener('message', (e) => {
      msgs.push(JSON.parse(String(e.data)));
      waiters.slice().forEach((w) => w());
    });
    const closed = new Promise<{ code: number; reason: string }>((res) =>
      ws.addEventListener('close', (e) => res({ code: e.code, reason: e.reason }))
    );
    const client: Client = {
      ws, msgs, closed,
      send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
      waitFor(pred, ms = 3000) {
        return new Promise((resolve, reject) => {
          const check = () => {
            const hit = msgs.find(pred);
            if (hit) { cleanup(); resolve(hit); return true; }
            return false;
          };
          const t = setTimeout(() => { cleanup(); reject(new Error('timeout waiting for message; got ' + JSON.stringify(msgs))); }, ms);
          const cleanup = () => { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
          if (!check()) waiters.push(check);
        });
      },
      async expectNone(pred, ms = 350) {
        await new Promise((r) => setTimeout(r, ms));
        expect(msgs.filter(pred)).toEqual([]);
      },
      close: () => { try { ws.close(); } catch { /* */ } },
    };
    return new Promise((resolve) => {
      ws.addEventListener('open', () => { clients.push(client); resolve(client); });
      ws.addEventListener('error', () => resolve(null));
      ws.addEventListener('close', () => resolve(null));
    });
  }

  async function sub(c: Client, channel: string) {
    c.send({ type: 'subscribe', channel });
    return c.waitFor((m) => (m.type === 'subscribed' || m.type === 'error') && m.channel === channel);
  }

  const isEvent = (m: any) => m.type === 'event';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    adminId = seeded.user.id;
    const created = await db.insert(schema.users).values(['viewer', 'outsider', 'customer'].map((n) => ({
      username: n, email: `${n}@example.com`, displayName: n === 'viewer' ? 'Vera Viewer' : n, passwordHash: hash,
    }))).returning();
    viewerId = created.find((u) => u.username === 'viewer')!.id;
    await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: viewerId });
    // The in-memory REST limiter outlives table truncation and user ids repeat across test files.
    for (let id = 1; id <= 10; id++) await redis.del(`veqsio:ratelimit:user:${id}`);
    admin = await login('admin'); viewer = await login('viewer'); outsider = await login('outsider'); customer = await login('customer');

    let res = await call(admin, 'POST', '/rest/api/2/issue', {
      fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Realtime issue', priority: { id: seeded.priority.id } },
    });
    expect(res.status).toBe(201);
    issueKey = (await res.json()).key;

    // A service desk request raised by a portal customer.
    res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'RT Desk', slug: 'rtdesk', publicSignup: true });
    const deskId = (await res.json()).id;
    res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`, {
      name: 'Help', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id, fields: [],
    });
    const rtId = (await res.json()).id;
    res = await call(customer, 'POST', '/rest/servicedeskapi/portal/rtdesk/request', { requestTypeId: rtId, summary: 'Customer request' });
    expect(res.status).toBe(201);
    requestKey = (await res.json()).key;

    handle = createServer({ port: 0, fetch: app.fetch });
    base = `ws://localhost:${handle.server.port}`;
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    handle.realtime.stop();
    handle.server.stop(true);
    await resetTestDb(testSql);
    await testSql.end();
  });

  const updateIssue = (summary: string) => call(admin, 'PUT', `/rest/api/2/issue/${issueKey}`, { fields: { summary } });

  test('app.fetch stays socket-free: /ws over plain HTTP is not served by Hono', async () => {
    const res = await app.request('/ws');
    expect(res.status).toBe(404);
  });

  test('unauthenticated connections are rejected', async () => {
    expect(await connect()).toBeNull();
    expect(await connect({ cookie: 'session=not-a-real-session' })).toBeNull();
    expect(await connect({ ticket: 'x'.repeat(43) })).toBeNull();
  });

  test('wrong Origin is rejected, matching Origin accepted', async () => {
    expect(await connect({ cookie: viewer, origin: 'https://evil.example.com' })).toBeNull();
    expect(await connect({ cookie: viewer, origin: ORIGIN + '.evil.com' })).toBeNull();
    const ok = await connect({ cookie: viewer });
    expect(ok).not.toBeNull();
    ok!.close();
  });

  test('ticket endpoint requires auth; tickets are single-use', async () => {
    const anon = await app.request('/rest/api/2/realtime/ticket', { method: 'POST' });
    expect(anon.status).toBe(401);
    const res = await call(viewer, 'POST', '/rest/api/2/realtime/ticket');
    expect(res.status).toBe(200);
    const { ticket, expiresIn } = await res.json();
    expect(ticket.length).toBeGreaterThanOrEqual(43);
    expect(expiresIn).toBe(30);
    const first = await connect({ ticket });
    expect(first).not.toBeNull();
    const hello = await first!.waitFor((m) => m.type === 'hello');
    expect(hello.userId).toBe(viewerId);
    expect(await connect({ ticket })).toBeNull(); // consumed
    first!.close();
  });

  test('subscribe is authorized server-side; forbidden and unknown channels get the same generic error', async () => {
    const c = await connect({ cookie: outsider });
    expect(c).not.toBeNull();
    const forbidden = await sub(c!, `project:${seeded.project.id}`);
    const forbiddenIssue = await sub(c!, `issue:${issueKey}`);
    const unknown = await sub(c!, 'project:99999');
    const unknownIssue = await sub(c!, 'issue:NOPE-1');
    const malformed = await sub(c!, 'project:1; DROP TABLE users');
    for (const [r, ch] of [[forbidden, `project:${seeded.project.id}`], [forbiddenIssue, `issue:${issueKey}`], [unknown, 'project:99999'], [unknownIssue, 'issue:NOPE-1']] as const) {
      expect(r).toEqual({ type: 'error', code: 'subscribe_failed', message: 'Cannot subscribe to this channel', channel: ch });
    }
    expect(malformed.type).toBe('error');
    c!.close();
  });

  test('unauthorized subscriber receives NOTHING when an issue changes; authorized user receives issue.updated', async () => {
    const out = await connect({ cookie: outsider });
    const view = await connect({ cookie: viewer });
    await sub(out!, `project:${seeded.project.id}`);
    await sub(out!, `issue:${issueKey}`);
    expect((await sub(view!, `project:${seeded.project.id}`)).type).toBe('subscribed');
    expect((await sub(view!, `issue:${issueKey}`)).type).toBe('subscribed');

    const res = await updateIssue('Changed live');
    expect(res.status).toBe(200);
    const ev = await view!.waitFor(isEvent);
    expect(ev.event).toMatchObject({ type: 'issue.updated', key: issueKey, projectId: seeded.project.id, actorId: adminId });
    expect(typeof ev.event.at).toBe('string');
    // Lightweight invalidation: no field values leak.
    expect(JSON.stringify(ev)).not.toContain('Changed live');
    expect(Object.keys(ev.event).sort()).toEqual(['actorId', 'at', 'key', 'projectId', 'type']);
    // one copy even though both project: and issue: channels match
    expect(view!.msgs.filter(isEvent)).toHaveLength(1);
    await out!.expectNone(isEvent);
    out!.close(); view!.close();
  });

  test('comment.added carries no comment body (also for internal notes)', async () => {
    const view = await connect({ cookie: viewer });
    await sub(view!, `project:${seeded.project.id}`);
    const res = await call(admin, 'POST', `/rest/api/2/issue/${issueKey}/comment`, { body: 'top secret comment body' });
    expect(res.status).toBe(201);
    const ev = await view!.waitFor((m) => m.type === 'event' && m.event.type === 'comment.added');
    expect(ev.event.key).toBe(issueKey);
    expect(JSON.stringify(view!.msgs)).not.toContain('top secret');
    view!.close();
  });

  test('issue.created, issue.transitioned and issue.deleted are published', async () => {
    const view = await connect({ cookie: viewer });
    await sub(view!, `board:${(await createBoard()).id}`);
    let res = await call(admin, 'POST', '/rest/api/2/issue', {
      fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Another', priority: { id: seeded.priority.id } },
    });
    const key2 = (await res.json()).key;
    await view!.waitFor((m) => m.type === 'event' && m.event.type === 'issue.created' && m.event.key === key2);
    res = await call(admin, 'GET', `/rest/api/2/issue/${key2}/transitions`);
    const tr = (await res.json()).transitions?.[0];
    if (tr) {
      res = await call(admin, 'POST', `/rest/api/2/issue/${key2}/transitions`, { transition: { id: tr.id } });
      expect(res.status).toBe(200);
      await view!.waitFor((m) => m.type === 'event' && m.event.type === 'issue.transitioned' && m.event.key === key2);
    }
    res = await call(admin, 'DELETE', `/rest/api/2/issue/${key2}`);
    expect(res.status).toBe(200);
    await view!.waitFor((m) => m.type === 'event' && m.event.type === 'issue.deleted' && m.event.key === key2);
    view!.close();
  });

  async function createBoard() {
    const db = createTestDb(testSql);
    const existing = await db.select().from(schema.boards).where(eq(schema.boards.projectId, seeded.project.id));
    if (existing[0]) return existing[0];
    const [b] = await db.insert(schema.boards).values({ name: 'RT board', type: 'kanban', projectId: seeded.project.id } as any).returning();
    return b;
  }

  test('customers (service desk portal users) cannot subscribe and receive nothing', async () => {
    const c = await connect({ cookie: customer });
    expect(c).not.toBeNull();
    expect((await sub(c!, `project:${seeded.project.id}`)).type).toBe('error');
    expect((await sub(c!, `issue:${requestKey}`)).type).toBe('error'); // their own request: use the portal, not the realtime channel
    // an agent comments internally on the customer's request
    const res = await call(admin, 'POST', `/rest/api/2/issue/${requestKey}/comment`, { body: 'internal only', internal: true });
    expect(res.status).toBe(201);
    await updateIssue('touch');
    await c!.expectNone((m) => m.type === 'event' || m.type === 'presence' || m.type === 'typing');
    expect(JSON.stringify(c!.msgs)).not.toContain('internal only');
    c!.close();
  });

  test('users without service-desk staff role cannot watch a request issue, even with BROWSE_PROJECTS', async () => {
    const v = await connect({ cookie: viewer });
    expect((await sub(v!, `issue:${requestKey}`)).type).toBe('error');
    const a = await connect({ cookie: admin });
    expect((await sub(a!, `issue:${requestKey}`)).type).toBe('subscribed');
    v!.close(); a!.close();
  });

  test('presence: join and leave, no email exposed', async () => {
    const a = await connect({ cookie: admin });
    const v = await connect({ cookie: viewer });
    await sub(a!, `issue:${issueKey}`);
    await sub(v!, `issue:${issueKey}`);
    const both = await a!.waitFor((m) => m.type === 'presence' && m.users.length === 2);
    const names = both.users.map((u: any) => u.displayName).sort();
    expect(names).toEqual(['Administrator', 'Vera Viewer']);
    expect(JSON.stringify(both)).not.toContain('@');
    v!.close();
    await a!.waitFor((m) => m.type === 'presence' && m.users.length === 1 && m.users[0].displayName === 'Administrator');
    a!.close();
  });

  test('typing is broadcast to others but not echoed to the sender', async () => {
    const a = await connect({ cookie: admin });
    const v = await connect({ cookie: viewer });
    await sub(a!, `issue:${issueKey}`);
    await sub(v!, `issue:${issueKey}`);
    v!.send({ type: 'typing', channel: `issue:${issueKey}` });
    const seen = await a!.waitFor((m) => m.type === 'typing' && m.users.length === 1);
    expect(seen.users).toEqual([{ id: viewerId, displayName: 'Vera Viewer' }]);
    expect(v!.msgs.filter((m) => m.type === 'typing' && m.users.length > 0)).toEqual([]);
    a!.close(); v!.close();
  });

  test('typing on a channel the socket has not joined is ignored', async () => {
    const a = await connect({ cookie: admin });
    const v = await connect({ cookie: viewer });
    await sub(v!, `issue:${issueKey}`);
    a!.send({ type: 'typing', channel: `issue:${issueKey}` });
    await v!.expectNone((m) => m.type === 'typing' && m.users.length > 0);
    a!.close(); v!.close();
  });

  test('oversized message closes the socket (1009)', async () => {
    const c = await connect({ cookie: viewer });
    c!.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(LIMITS.maxMessageBytes + 100) }));
    const { code } = await c!.closed;
    expect(code).toBe(1009);
  });

  test('flooding closes the socket with policy violation (1008)', async () => {
    const c = await connect({ cookie: viewer });
    for (let i = 0; i < LIMITS.rateLimitMessages + 5; i++) c!.send({ type: 'ping' });
    const { code } = await c!.closed;
    expect(code).toBe(1008);
  });

  test('connections per user are capped', async () => {
    const open: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerUser; i++) {
      const c = await connect({ cookie: outsider });
      expect(c).not.toBeNull();
      open.push(c!);
    }
    expect(await connect({ cookie: outsider })).toBeNull();
    open.forEach((c) => c.close());
  });
});
