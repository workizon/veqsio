import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { recordInbox } from '../../src/services/inbox';

describe('In-app inbox', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  let adminCookie = '';
  let bobCookie = '';
  let bobId = 0;

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string) => {
    const r = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) });
    return r.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    await resetRateLimits();
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [bob] = await db.insert(schema.users).values({ username: 'bob', email: 'bob@veqsio.local', displayName: 'Bob', passwordHash: hash }).returning();
    bobId = bob.id;
    adminCookie = await login('admin');
    bobCookie = await login('bob');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('requires a session', async () => {
    expect((await app.request('/rest/api/2/inbox')).status).toBe(401);
  });

  test('a user sees only their own notifications, with an unread count', async () => {
    await recordInbox([bobId], { kind: 'mention', title: 'Alice mentioned you in TEST-1', body: 'hi', link: '/issues/TEST-1' });
    await recordInbox([seeded.user.id], { kind: 'comment', title: 'for admin only' });
    const bob = await (await call('GET', '/rest/api/2/inbox', bobCookie)).json();
    expect(bob.unread).toBe(1);
    expect(bob.items.map((i: any) => i.title)).toEqual(['Alice mentioned you in TEST-1']);
    const admin = await (await call('GET', '/rest/api/2/inbox', adminCookie)).json();
    expect(admin.items.map((i: any) => i.title)).toEqual(['for admin only']);
  });

  test("marking read never touches somebody else's rows", async () => {
    const adminItem = (await (await call('GET', '/rest/api/2/inbox', adminCookie)).json()).items[0];
    await call('POST', '/rest/api/2/inbox/read', bobCookie, { ids: [adminItem.id] });
    expect((await (await call('GET', '/rest/api/2/inbox', adminCookie)).json()).unread).toBe(1);
    await call('POST', '/rest/api/2/inbox/read', bobCookie, {});
    const bob = await (await call('GET', '/rest/api/2/inbox', bobCookie)).json();
    expect(bob.unread).toBe(0);
    expect(bob.items[0].read).toBe(true);
    expect((await (await call('GET', '/rest/api/2/inbox', adminCookie)).json()).unread).toBe(1);
  });
});
