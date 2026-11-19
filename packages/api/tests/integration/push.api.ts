import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { setPushSender, sendPush } from '../../src/services/push';

describe('Web push', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let bob: { id: number };
  let sent: { endpoint: string; payload: any }[] = [];
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 300));

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    [bob] = await db.insert(schema.users).values({ username: 'bobby', email: 'bobby@example.com', displayName: 'Bob', active: true }).returning();
    await db.insert(schema.pushSubscriptions).values({ userId: bob.id, endpoint: 'https://push.example/bob', p256dh: 'k', auth: 'a' });
    setPushSender(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); });
  });
  afterAll(async () => { setPushSender(null); await resetTestDb(testSql); await testSql.end(); });

  const newIssue = async () => (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Push test' } })).json()).key as string;

  test('subscription API needs login, rejects non-https endpoints, stores and removes', async () => {
    expect((await app.request('/rest/api/2/push/key')).status).toBe(401);
    const k = await (await call('GET', '/rest/api/2/push/key')).json();
    expect(typeof k.publicKey).toBe('string');
    expect(k.privateKey).toBeUndefined();
    expect((await call('POST', '/rest/api/2/push/subscription', { endpoint: 'http://x.test/a', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/push/subscription', { endpoint: 'https://push.example/admin', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(201);
    expect((await call('DELETE', '/rest/api/2/push/subscription', { endpoint: 'https://push.example/admin' })).status).toBe(204);
    const left = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, 'https://push.example/admin'));
    expect(left.length).toBe(0);
  });

  test('assignment pushes to the new assignee only', async () => {
    const key = await newIssue();
    sent = [];
    const r = await call('PUT', `/rest/api/2/issue/${key}`, { fields: { assignee: { id: bob.id } } });
    expect(r.status).toBe(200);
    await settle();
    expect(sent.length).toBe(1);
    expect(sent[0].endpoint).toBe('https://push.example/bob');
    expect(sent[0].payload.url).toBe(`/issues/${key}`);
    expect(sent[0].payload.title).toContain('assigned');
  });

  test('a mention pushes once, as a mention', async () => {
    const key = await newIssue();
    sent = [];
    const r = await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'Please look, @bobby.' });
    expect(r.status).toBe(201);
    await settle();
    expect(sent.length).toBe(1);
    expect(sent[0].payload.title).toContain('mentioned you');
  });

  test('preferences API: needs login, validates strictly, merges changes and spells every kind out', async () => {
    expect((await app.request('/rest/api/2/push/preferences')).status).toBe(401);
    expect((await app.request('/rest/api/2/push/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const d = await (await call('GET', '/rest/api/2/push/preferences')).json();
    expect(d.events).toEqual({ assignment: true, mention: true, comment: true, oncall: true });
    expect(d).toMatchObject({ quietEnabled: false, quietStart: '22:00', quietEnd: '07:00', timezone: 'UTC' });
    expect(d.kinds.map((k: any) => k.key)).toEqual(['assignment', 'mention', 'comment', 'oncall']);
    for (const bad of [{ events: { shout: true } }, { events: { comment: 'no' } }, { quietStart: '25:00' }, { quietEnd: '7:00' }, { timezone: 'Mars/Olympus' }, { bogus: 1 }, { quietEnabled: 'yes' }]) {
      expect((await call('PUT', '/rest/api/2/push/preferences', bad)).status).toBe(400);
    }
    const a = await (await call('PUT', '/rest/api/2/push/preferences', { events: { comment: false }, quietEnabled: true, timezone: 'Europe/Berlin' })).json();
    expect(a.events.comment).toBe(false);
    expect(a).toMatchObject({ quietEnabled: true, timezone: 'Europe/Berlin', quietStart: '22:00' });
    // a later change leaves the rest as it was
    const b = await (await call('PUT', '/rest/api/2/push/preferences', { quietStart: '21:30' })).json();
    expect(b).toMatchObject({ quietStart: '21:30', quietEnabled: true, timezone: 'Europe/Berlin' });
    expect(b.events.comment).toBe(false);
    // switching a kind back on removes it from what is stored (a missing switch means on)
    await call('PUT', '/rest/api/2/push/preferences', { events: { comment: true } });
    const [row] = await db.select().from(schema.pushPreferences).where(eq(schema.pushPreferences.userId, seeded.user.id));
    expect(row.events).toEqual({});
    await db.delete(schema.pushPreferences).where(eq(schema.pushPreferences.userId, seeded.user.id));
  });

  test('a person’s switches and quiet hours decide what is pushed to them', async () => {
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    const around = { quietEnabled: true, quietStart: hhmm(new Date(Date.now() - 3_600_000)), quietEnd: hhmm(new Date(Date.now() + 3_600_000)), timezone: 'UTC' };
    // 1. assignments switched off: no assignment push, the mention still arrives
    await db.insert(schema.pushPreferences).values({ userId: bob.id, events: { assignment: false } });
    let key = await newIssue(); sent = [];
    await call('PUT', `/rest/api/2/issue/${key}`, { fields: { assignee: { id: bob.id } } });
    await settle();
    expect(sent.length).toBe(0);
    await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'Hello @bobby' });
    await settle();
    expect(sent.map((x) => x.payload.title)).toEqual([expect.stringContaining('mentioned you')]);
    // 2. quiet hours around now: nothing but an on-call page gets through
    await db.update(schema.pushPreferences).set({ events: {}, ...around }).where(eq(schema.pushPreferences.userId, bob.id));
    key = await newIssue(); sent = [];
    await call('PUT', `/rest/api/2/issue/${key}`, { fields: { assignee: { id: bob.id } } });
    await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'Hello @bobby' });
    await settle();
    expect(sent.length).toBe(0);
    expect(await sendPush([bob.id], { title: 'Page', body: 'db down', url: '/admin/oncall', kind: 'oncall' })).toBe(1);
    // 3. the on-call switch itself still wins
    await db.update(schema.pushPreferences).set({ events: { oncall: false } }).where(eq(schema.pushPreferences.userId, bob.id));
    expect(await sendPush([bob.id], { title: 'Page', body: 'db down', url: '/admin/oncall', kind: 'oncall' })).toBe(0);
    // 4. outside the quiet window everything is delivered again, and a push without a kind ignores preferences
    await db.update(schema.pushPreferences).set({ events: {}, quietStart: hhmm(new Date(Date.now() + 3 * 3_600_000)), quietEnd: hhmm(new Date(Date.now() + 5 * 3_600_000)) }).where(eq(schema.pushPreferences.userId, bob.id));
    sent = [];
    await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'Back to normal @bobby' });
    await settle();
    expect(sent.length).toBe(1);
    await db.update(schema.pushPreferences).set({ events: { comment: false, mention: false, assignment: false, oncall: false }, ...around }).where(eq(schema.pushPreferences.userId, bob.id));
    expect(await sendPush([bob.id], { title: 'Legacy', body: 'no kind', url: '/' })).toBe(1);
    await db.delete(schema.pushPreferences).where(eq(schema.pushPreferences.userId, bob.id));
  });

  test('a gone subscription (410) is removed', async () => {
    setPushSender(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); });
    const key = await newIssue();
    await call('PUT', `/rest/api/2/issue/${key}`, { fields: { assignee: { id: bob.id } } });
    await settle();
    const left = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, bob.id));
    expect(left.length).toBe(0);
  });
});
