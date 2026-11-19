import { describe, test, expect } from 'bun:test';
import { Hub, RateLimiter, LIMITS, parseChannel, colorForUser, type HubConn, type Bus, type RealtimeEvent } from './hub';

function mkConn(id: string, userId: number, name = `user${userId}`) {
  const sent: any[] = [];
  const closed: Array<[number, string]> = [];
  const conn: HubConn = {
    id,
    userId,
    user: { id: userId, displayName: name, avatarUrl: null, color: colorForUser(userId) },
    send: (d) => sent.push(JSON.parse(d)),
    close: (c, r) => closed.push([c, r]),
  };
  return { conn, sent, closed };
}
const ev = (over: Partial<RealtimeEvent> = {}): RealtimeEvent => ({
  type: 'issue.updated', key: 'TEST-1', projectId: 1, actorId: 9, at: new Date().toISOString(), ...over,
});
const events = (sent: any[]) => sent.filter((m) => m.type === 'event');
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('parseChannel', () => {
  test('accepts the three channel kinds, rejects everything else', () => {
    expect(parseChannel('project:12')).toMatchObject({ kind: 'project', id: 12 });
    expect(parseChannel('board:3')).toMatchObject({ kind: 'board', id: 3 });
    expect(parseChannel('issue:TEST-5')).toMatchObject({ kind: 'issue', key: 'TEST-5' });
    for (const bad of ['', 'project:', 'project:-1', 'project:1;DROP', 'issue:test-1x', 'issue:1-1', 'user:1', 'project:12345678901', null, 5, {}]) {
      expect(parseChannel(bad as any)).toBeNull();
    }
    expect(parseChannel('issue:' + 'A'.repeat(100) + '-1')).toBeNull();
  });
});

describe('Hub subscribe / publish / unsubscribe', () => {
  test('delivers only to subscribers of the matching project / issue', () => {
    const hub = new Hub();
    const a = mkConn('a', 1), b = mkConn('b', 2), c = mkConn('c', 3);
    [a, b, c].forEach((x) => hub.addConnection(x.conn));
    hub.subscribe('a', 'project:1', 1);
    hub.subscribe('b', 'issue:TEST-1', 1);
    hub.subscribe('c', 'project:2', 2);
    hub.publish(ev());
    expect(events(a.sent)).toHaveLength(1);
    expect(events(b.sent)).toHaveLength(1);
    expect(events(c.sent)).toHaveLength(0);
    expect(events(a.sent)[0].event).toEqual(expect.objectContaining({ type: 'issue.updated', key: 'TEST-1', projectId: 1, actorId: 9 }));
  });

  test('a connection subscribed to overlapping channels gets one copy', () => {
    const hub = new Hub();
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    hub.subscribe('a', 'project:1', 1);
    hub.subscribe('a', 'issue:TEST-1', 1);
    hub.subscribe('a', 'board:7', 1);
    hub.publish(ev());
    expect(events(a.sent)).toHaveLength(1);
  });

  test('board channels receive issue events of their project only', () => {
    const hub = new Hub();
    const a = mkConn('a', 1), b = mkConn('b', 2);
    hub.addConnection(a.conn); hub.addConnection(b.conn);
    hub.subscribe('a', 'board:7', 1);
    hub.subscribe('b', 'board:8', 2);
    hub.publish(ev({ projectId: 1 }));
    expect(events(a.sent)).toHaveLength(1);
    expect(events(b.sent)).toHaveLength(0);
    hub.unsubscribe('a', 'board:7');
    hub.publish(ev({ projectId: 1 }));
    expect(events(a.sent)).toHaveLength(1);
  });

  test('unsubscribe and removeConnection stop delivery', () => {
    const hub = new Hub();
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    hub.subscribe('a', 'project:1', 1);
    hub.unsubscribe('a', 'project:1');
    hub.publish(ev());
    expect(events(a.sent)).toHaveLength(0);
    hub.subscribe('a', 'project:1', 1);
    hub.removeConnection('a');
    hub.publish(ev());
    expect(events(a.sent)).toHaveLength(0);
    expect(hub.connectionCount()).toBe(0);
  });

  test('caps subscriptions per connection', () => {
    const hub = new Hub();
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    for (let i = 1; i <= LIMITS.maxSubscriptions; i++) expect(hub.subscribe('a', `project:${i}`, i)).toBe('ok');
    expect(hub.subscribe('a', 'project:999', 999)).toBe('limit');
    expect(hub.subscribe('a', 'project:1', 1)).toBe('ok'); // re-subscribe is idempotent
  });

  test('a throwing socket never breaks publishing to others', () => {
    const hub = new Hub();
    const bad = mkConn('bad', 1), good = mkConn('good', 2);
    bad.conn.send = () => { throw new Error('closed'); };
    hub.addConnection(bad.conn); hub.addConnection(good.conn);
    hub.subscribe('bad', 'project:1', 1); hub.subscribe('good', 'project:1', 1);
    expect(() => hub.publish(ev())).not.toThrow();
    expect(events(good.sent)).toHaveLength(1);
  });
});

describe('Hub re-authorization on delivery', () => {
  test('revoked access stops delivery after the cache TTL and drops the subscription', async () => {
    let allowed = true;
    let now = 1_000_000;
    const hub = new Hub({ authorize: async () => allowed, now: () => now, permissionTtlMs: 30_000 });
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    hub.subscribe('a', 'project:1', 1);
    hub.publish(ev());
    expect(events(a.sent)).toHaveLength(1);
    allowed = false;
    hub.publish(ev()); // still within TTL: cached positive result
    expect(events(a.sent)).toHaveLength(2);
    now += 31_000;
    hub.publish(ev());
    await tick();
    expect(events(a.sent)).toHaveLength(2);
    expect(a.sent.some((m) => m.type === 'unsubscribed' && m.channel === 'project:1')).toBe(true);
    expect(hub.isSubscribed('a', 'project:1')).toBe(false);
    hub.publish(ev());
    await tick();
    expect(events(a.sent)).toHaveLength(2);
  });

  test('authorizer failure fails closed', async () => {
    let now = 5_000_000;
    const hub = new Hub({ authorize: async () => { throw new Error('db down'); }, now: () => now, permissionTtlMs: 10 });
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    hub.subscribe('a', 'project:1', 1);
    now += 100;
    hub.publish(ev());
    await tick();
    expect(events(a.sent)).toHaveLength(0);
  });
});

describe('Presence', () => {
  test('join, dedupe by user, leave; no email exposed', () => {
    const hub = new Hub();
    const a = mkConn('a', 1, 'Alex'), a2 = mkConn('a2', 1, 'Alex'), b = mkConn('b', 2, 'Bo');
    [a, a2, b].forEach((x) => hub.addConnection(x.conn));
    hub.subscribe('a', 'issue:TEST-1', 1);
    hub.subscribe('b', 'issue:TEST-1', 1);
    hub.subscribe('a2', 'issue:TEST-1', 1);
    const last = [...a.sent].reverse().find((m) => m.type === 'presence');
    expect(last.users.map((u: any) => u.displayName)).toEqual(['Alex', 'Bo']);
    expect(Object.keys(last.users[0]).sort()).toEqual(['avatarUrl', 'color', 'displayName', 'id']);
    hub.unsubscribe('a2', 'issue:TEST-1');
    expect(hub.getPresence('issue:TEST-1')).toHaveLength(2); // Alex still present via tab 1
    hub.removeConnection('a');
    expect(hub.getPresence('issue:TEST-1').map((u) => u.id)).toEqual([2]);
    const lastB = [...b.sent].reverse().find((m) => m.type === 'presence');
    expect(lastB.users.map((u: any) => u.id)).toEqual([2]);
  });

  test('project channels carry no presence', () => {
    const hub = new Hub();
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    hub.subscribe('a', 'project:1', 1);
    expect(a.sent.some((m) => m.type === 'presence')).toBe(false);
  });

  test('stale connections are swept (presence expiry)', () => {
    let now = 1000;
    const hub = new Hub({ now: () => now });
    const a = mkConn('a', 1), b = mkConn('b', 2);
    hub.addConnection(a.conn); hub.addConnection(b.conn);
    hub.subscribe('a', 'issue:TEST-1', 1); hub.subscribe('b', 'issue:TEST-1', 1);
    now += LIMITS.presenceStaleMs - 1000;
    hub.touch('b'); // heartbeat
    now += 2000;
    hub.sweep();
    expect(a.closed).toHaveLength(1);
    expect(b.closed).toHaveLength(0);
    expect(hub.getPresence('issue:TEST-1').map((u) => u.id)).toEqual([2]);
  });
});

describe('Typing', () => {
  test('broadcasts to others (not the sender), auto-expires', async () => {
    const hub = new Hub({ typingTtlMs: 30 });
    const a = mkConn('a', 1, 'Alex'), b = mkConn('b', 2, 'Bo');
    hub.addConnection(a.conn); hub.addConnection(b.conn);
    hub.subscribe('a', 'issue:TEST-1', 1); hub.subscribe('b', 'issue:TEST-1', 1);
    expect(hub.typing('a', 'issue:TEST-1')).toBe(true);
    const lastB = [...b.sent].reverse().find((m) => m.type === 'typing');
    expect(lastB.users).toEqual([{ id: 1, displayName: 'Alex' }]);
    const lastA = [...a.sent].reverse().find((m) => m.type === 'typing');
    expect(lastA.users).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect([...b.sent].reverse().find((m) => m.type === 'typing').users).toEqual([]);
    expect(hub.getTyping('issue:TEST-1')).toHaveLength(0);
  });

  test('requires an issue-channel subscription', () => {
    const hub = new Hub();
    const a = mkConn('a', 1);
    hub.addConnection(a.conn);
    expect(hub.typing('a', 'issue:TEST-1')).toBe(false);
    hub.subscribe('a', 'project:1', 1);
    expect(hub.typing('a', 'project:1')).toBe(false);
  });
});

describe('RateLimiter', () => {
  test('allows N per window then blocks, recovers after the window', () => {
    let now = 0;
    const rl = new RateLimiter(3, 1000, () => now);
    expect([rl.allow(), rl.allow(), rl.allow(), rl.allow()]).toEqual([true, true, true, false]);
    now += 1001;
    expect(rl.allow()).toBe(true);
  });
  test('defaults match the documented limits', () => {
    expect(LIMITS.rateLimitMessages).toBe(30);
    expect(LIMITS.rateLimitWindowMs).toBe(10_000);
    expect(LIMITS.maxMessageBytes).toBe(8192);
  });
});

describe('Multi-instance fan-out via a Bus', () => {
  function makeBus() {
    const handlers: Array<(m: string) => void> = [];
    const mk = (): Bus => {
      let cb: (m: string) => void = () => {};
      return {
        publish: (m) => queueMicrotask(() => handlers.forEach((h) => h(m))),
        onMessage: (c) => { cb = c; handlers.push(c); void cb; },
      };
    };
    return mk;
  }

  test('events published on one instance reach subscribers on another (exactly once each)', async () => {
    const mk = makeBus();
    const h1 = new Hub({ bus: mk(), instanceId: 'i1' }), h2 = new Hub({ bus: mk(), instanceId: 'i2' });
    const a = mkConn('a', 1), b = mkConn('b', 2);
    h1.addConnection(a.conn); h2.addConnection(b.conn);
    h1.subscribe('a', 'project:1', 1); h2.subscribe('b', 'project:1', 1);
    h1.publish(ev());
    await tick();
    expect(events(a.sent)).toHaveLength(1);
    expect(events(b.sent)).toHaveLength(1);
  });

  test('presence and typing are shared across instances', async () => {
    const mk = makeBus();
    const h1 = new Hub({ bus: mk(), instanceId: 'i1' }), h2 = new Hub({ bus: mk(), instanceId: 'i2' });
    const a = mkConn('a', 1, 'Alex'), b = mkConn('b', 2, 'Bo');
    h1.addConnection(a.conn); h2.addConnection(b.conn);
    h1.subscribe('a', 'issue:TEST-1', 1); h2.subscribe('b', 'issue:TEST-1', 1);
    await tick();
    expect(h2.getPresence('issue:TEST-1').map((u) => u.id)).toEqual([1, 2]);
    h1.typing('a', 'issue:TEST-1');
    await tick();
    expect([...b.sent].reverse().find((m) => m.type === 'typing').users).toEqual([{ id: 1, displayName: 'Alex' }]);
    h1.removeConnection('a');
    await tick();
    expect(h2.getPresence('issue:TEST-1').map((u) => u.id)).toEqual([2]);
  });

  test('remote presence expires without heartbeats', async () => {
    const mk = makeBus();
    let now = 0;
    const h1 = new Hub({ bus: mk(), instanceId: 'i1', now: () => now }), h2 = new Hub({ bus: mk(), instanceId: 'i2', now: () => now });
    const a = mkConn('a', 1), b = mkConn('b', 2);
    h1.addConnection(a.conn); h2.addConnection(b.conn);
    h1.subscribe('a', 'issue:TEST-1', 1); h2.subscribe('b', 'issue:TEST-1', 1);
    await tick();
    expect(h2.getPresence('issue:TEST-1')).toHaveLength(2);
    now += LIMITS.remotePresenceTtlMs + 1;
    expect(h2.getPresence('issue:TEST-1').map((u) => u.id)).toEqual([2]);
  });
});
