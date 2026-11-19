import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { setPushSender } from '../../src/services/push';

describe('On-call schedules', () => {
  let seeded: any; let cookie: string; let bob: { id: number };
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const P = '/rest/api/2/oncall/schedule';
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    [bob] = await db.insert(schema.users).values({ username: 'oncallbob', email: 'oncallbob@example.com', displayName: 'Bob', active: true }).returning();
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs login; validates input', async () => {
    expect((await app.request(P)).status).toBe(401);
    expect((await call('POST', P, { name: '', rotationHours: 24, startAt: hours(-1), memberIds: [] })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', rotationHours: 24, startAt: hours(-1), memberIds: [seeded.user.id, seeded.user.id] })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', rotationHours: 24, startAt: hours(-1), memberIds: [999999] })).status).toBe(400);
  });

  test('rotation, override and shifts', async () => {
    const res = await call('POST', P, { name: 'Primary', rotationHours: 24, startAt: hours(-1), memberIds: [seeded.user.id, bob.id] });
    expect(res.status).toBe(201);
    const s = await res.json();
    expect(s.onCall.id).toBe(seeded.user.id);
    expect(s.onCall.override).toBe(false);

    const ov = await call('POST', `${P}/${s.id}/override`, { userId: bob.id, startsAt: hours(-0.5), endsAt: hours(2) });
    expect(ov.status).toBe(201);
    const withOv = await ov.json();
    expect(withOv.onCall).toMatchObject({ id: bob.id, override: true });
    expect((await call('POST', `${P}/${s.id}/override`, { userId: bob.id, startsAt: hours(2), endsAt: hours(1) })).status).toBe(400);

    const shifts = await (await call('GET', `${P}/${s.id}/shifts?from=${encodeURIComponent(hours(-0.5))}&to=${encodeURIComponent(hours(30))}`)).json();
    expect(shifts.shifts[0]).toMatchObject({ override: true, user: { id: bob.id } });
    expect(shifts.shifts.length).toBeGreaterThanOrEqual(3);

    expect((await call('DELETE', `${P}/${s.id}/override/${withOv.overrides[0].id}`)).status).toBe(204);
    expect((await (await call('GET', `${P}/${s.id}`)).json()).onCall.id).toBe(seeded.user.id);

    const upd = await call('PUT', `${P}/${s.id}`, { name: 'Primary 2', rotationHours: 12, startAt: hours(-1), memberIds: [bob.id] });
    expect((await upd.json()).members.length).toBe(1);
    expect((await call('DELETE', `${P}/${s.id}`)).status).toBe(204);
    expect((await call('GET', `${P}/${s.id}`)).status).toBe(404);
  });
});

describe('On-call alerts', () => {
  let seeded: any; let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alert = (key: string | null, body: unknown) =>
    app.request('/rest/api/2/oncall/alert', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-veqsio-alert-key': key } : {}) }, body: JSON.stringify(body) });
  let key: string; let sid: number;

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    const s = await (await call('POST', '/rest/api/2/oncall/schedule', { name: 'Alerts', rotationHours: 24, startAt: new Date(Date.now() - 3_600_000).toISOString(), memberIds: [seeded.user.id] })).json();
    sid = s.id;
    key = (await (await call('POST', `/rest/api/2/oncall/schedule/${sid}/key`)).json()).key;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('rejects missing or wrong keys and bad payloads', async () => {
    expect((await alert(null, { title: 'x' })).status).toBe(401);
    expect((await alert('vqa_wrong', { title: 'x' })).status).toBe(401);
    expect((await alert(key, {})).status).toBe(400);
  });

  test('opens, deduplicates, acknowledges, snoozes and resolves', async () => {
    const r1 = await alert(key, { title: 'Disk full', severity: 'P1', description: 'db-1 at 99%' });
    expect(r1.status).toBe(201);
    const a = await r1.json();
    expect(a.notified).toBe(seeded.user.id);
    const r2 = await (await alert(key, { title: 'Disk full' })).json();
    expect(r2).toMatchObject({ id: a.id, deduplicated: true });

    const list = await (await call('GET', '/rest/api/2/oncall/alert?status=active')).json();
    const found = list.alerts.find((x: any) => x.id === a.id);
    expect(found).toMatchObject({ count: 2, severity: 'critical', status: 'open' });

    expect((await (await call('POST', `/rest/api/2/oncall/alert/${a.id}/acknowledge`, {})).json()).status).toBe('acknowledged');
    expect((await call('POST', `/rest/api/2/oncall/alert/${a.id}/snooze`, { minutes: 30 })).status).toBe(200);
    expect((await call('POST', `/rest/api/2/oncall/alert/${a.id}/snooze`, { minutes: 0 })).status).toBe(400);

    expect((await (await alert(key, { title: 'Disk full', status: 'resolved' })).json()).status).toBe('closed');
    expect((await call('POST', `/rest/api/2/oncall/alert/${a.id}/close`, {})).status).toBe(409);
    // a new firing after recovery opens a fresh alert
    expect((await alert(key, { title: 'Disk full' })).status).toBe(201);
  });

  test('a replaced key stops working; non-members cannot act', async () => {
    const newKey = (await (await call('POST', `/rest/api/2/oncall/schedule/${sid}/key`)).json()).key;
    expect((await alert(key, { title: 'old key' })).status).toBe(401);
    expect((await alert(newKey, { title: 'new key' })).status).toBe(201);
    const id = (await (await call('GET', '/rest/api/2/oncall/alert?status=open')).json()).alerts[0].id;
    const [eve] = await db.insert(schema.users).values({ username: 'eve-oncall', email: 'eve-oncall@example.com', displayName: 'Eve', active: true }).returning();
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('eve12345', 12) }).where(eq(schema.users.id, eve.id));
    const l = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'eve-oncall', password: 'eve12345' }) });
    const eveCookie = l.headers.get('set-cookie') || '';
    const r = await app.request(`/rest/api/2/oncall/alert/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: eveCookie }, body: '{}' });
    expect(r.status).toBe(403);
  });
});

describe('On-call escalation', () => {
  let seeded: any; let cookie: string; let bob: { id: number };
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    [bob] = await db.insert(schema.users).values({ username: 'escbob', email: 'escbob@example.com', displayName: 'Bob', active: true }).returning();
  });
  afterAll(async () => { setPushSender(null); await resetTestDb(testSql); await testSql.end(); });

  test('escalates an unacknowledged alert once, to the next person; acknowledged and snoozed ones wait', async () => {
    const { runOncallEscalation } = await import('../../src/oncall/escalation');
    const s = await (await call('POST', '/rest/api/2/oncall/schedule', { name: 'Esc', rotationHours: 24, startAt: new Date(Date.now() - 3_600_000).toISOString(), memberIds: [seeded.user.id, bob.id], escalationMinutes: 15 })).json();
    expect(s.escalationMinutes).toBe(15);
    const [a1] = await db.insert(schema.oncallAlerts).values({ scheduleId: s.id, dedupKey: 'a1', title: 'Late', notifiedUserId: seeded.user.id, firstSeenAt: new Date(Date.now() - 20 * 60_000) }).returning();
    const [a2] = await db.insert(schema.oncallAlerts).values({ scheduleId: s.id, dedupKey: 'a2', title: 'Fresh', notifiedUserId: seeded.user.id, firstSeenAt: new Date(Date.now() - 5 * 60_000) }).returning();
    const [a3] = await db.insert(schema.oncallAlerts).values({ scheduleId: s.id, dedupKey: 'a3', title: 'Acked', status: 'acknowledged', notifiedUserId: seeded.user.id, firstSeenAt: new Date(Date.now() - 30 * 60_000) }).returning();
    const [a4] = await db.insert(schema.oncallAlerts).values({ scheduleId: s.id, dedupKey: 'a4', title: 'Snoozed', notifiedUserId: seeded.user.id, firstSeenAt: new Date(Date.now() - 30 * 60_000), snoozedUntil: new Date(Date.now() + 3_600_000) }).returning();

    await db.insert(schema.pushSubscriptions).values({ userId: bob.id, endpoint: 'https://push.example/escbob', p256dh: 'k', auth: 'a' });
    const sent: string[] = [];
    setPushSender(async (sub, payload) => { sent.push(`${sub.endpoint}|${JSON.parse(payload).title}`); });

    expect(await runOncallEscalation()).toBe(1);
    expect(sent).toEqual(['https://push.example/escbob|[ESCALATED] Late']);
    expect(await runOncallEscalation()).toBe(0);
    const rows = await db.select().from(schema.oncallAlerts);
    expect(rows.find((r) => r.id === a1.id)?.escalatedUserId).toBe(bob.id);
    for (const id of [a2.id, a3.id, a4.id]) expect(rows.find((r) => r.id === id)?.escalatedAt).toBeNull();
  });

  test('rejects an unknown or self escalation schedule', async () => {
    const s = await (await call('POST', '/rest/api/2/oncall/schedule', { name: 'Solo', rotationHours: 24, startAt: new Date().toISOString(), memberIds: [seeded.user.id] })).json();
    expect((await call('PUT', `/rest/api/2/oncall/schedule/${s.id}`, { name: 'Solo', rotationHours: 24, startAt: new Date().toISOString(), memberIds: [seeded.user.id], escalationScheduleId: s.id })).status).toBe(400);
    expect((await call('PUT', `/rest/api/2/oncall/schedule/${s.id}`, { name: 'Solo', rotationHours: 24, startAt: new Date().toISOString(), memberIds: [seeded.user.id], escalationScheduleId: 999999 })).status).toBe(400);
  });
});
