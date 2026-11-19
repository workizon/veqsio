import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Status groups, status deletion and the default workflow', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let admin: string;
  let viewer: string;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [v] = await db.insert(schema.users).values({ username: 'viewer', email: 'v@x.test', displayName: 'Viewer', passwordHash: hash }).returning();
    await redis.del(`veqsio:ratelimit:user:${seeded.user.id}`, `veqsio:ratelimit:user:${v.id}`, 'veqsio:ratelimit:ip:unknown');
    admin = await login('admin');
    viewer = await login('viewer');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('all five groups can be used as a status category', async () => {
    for (const category of ['backlog', 'to_do', 'in_progress', 'done', 'cancelled']) {
      const r = await req('POST', '/rest/api/2/admin/status', admin, { name: `S-${category}`, category });
      expect(r.status).toBe(201);
      expect(((await r.json()) as any).category).toBe(category);
    }
    expect((await req('POST', '/rest/api/2/admin/status', admin, { name: 'Bad', category: 'archived' })).status).toBe(400);
    const meta = await (await req('GET', '/rest/api/2/status', viewer)).json() as any[];
    expect(meta.find((s) => s.name === 'S-cancelled').statusCategory.key).toBe('cancelled');
  });

  test('a status with issues cannot be deleted: 409 with the count', async () => {
    const db = createTestDb(testSql);
    const [st] = await db.insert(schema.statuses).values({ name: 'Wontdo', category: 'cancelled' }).returning();
    await db.insert(schema.issues).values([1, 2].map((n) => ({
      issueKey: `TEST-${n}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: st.id, summary: `i${n}`, reporterId: seeded.user.id,
    })));
    const res = await req('DELETE', `/rest/api/2/admin/status/${st.id}`, admin);
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.issueCount).toBe(2);
    expect(body.errorMessages[0]).toContain('2 issues');
    const list = await (await req('GET', '/rest/api/2/admin/status', admin)).json() as any;
    expect(list.statuses.find((s: any) => s.id === st.id).issueCount).toBe(2);
    expect((await req('DELETE', `/rest/api/2/admin/status/${st.id}`, viewer)).status).toBe(403);
    await db.delete(schema.issues).where(eq(schema.issues.statusId, st.id));
    expect((await req('DELETE', `/rest/api/2/admin/status/${st.id}`, admin)).status).toBe(200);
  });

  test('exactly one default workflow: switching moves it, unsetting or deleting it is refused', async () => {
    const created = await (await req('POST', '/rest/api/2/admin/workflow', admin, { name: 'Second' })).json() as any;
    const list = async () => ((await (await req('GET', '/rest/api/2/admin/workflow', admin)).json()) as any).workflows as any[];
    expect((await list()).filter((w) => w.isDefault)).toHaveLength(1);

    const orig = (await list()).find((w) => w.isDefault);
    expect((await req('PUT', `/rest/api/2/admin/workflow/${orig.id}`, admin, { isDefault: false })).status).toBe(409);
    expect((await req('DELETE', `/rest/api/2/admin/workflow/${orig.id}`, admin)).status).toBe(409);

    expect((await req('PUT', `/rest/api/2/admin/workflow/${created.id}`, admin, { isDefault: true })).status).toBe(200);
    expect((await list()).filter((w) => w.isDefault).map((w) => w.id)).toEqual([created.id]);

    // the database refuses a second default even when the application is bypassed
    const db = createTestDb(testSql);
    let failed = false;
    try { await db.update(schema.workflows).set({ isDefault: true }).where(eq(schema.workflows.id, orig.id)); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  test('roadmap progress treats cancelled work as out of scope', async () => {
    const db = createTestDb(testSql);
    const [epicT] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    const [done] = await db.insert(schema.statuses).values({ name: 'Finished', category: 'done' }).returning();
    const [canc] = await db.insert(schema.statuses).values({ name: 'Dropped', category: 'cancelled' }).returning();
    const mk = (key: string, over: any) => db.insert(schema.issues).values({
      issueKey: key, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: key, reporterId: seeded.user.id, ...over,
    }).returning();
    const [epic] = await mk('TEST-10', { issueTypeId: epicT.id, startDate: new Date('2026-01-01') });
    await mk('TEST-11', { parentId: epic.id, statusId: done.id });
    await mk('TEST-12', { parentId: epic.id, statusId: canc.id });
    await mk('TEST-13', { parentId: epic.id, statusId: canc.id });
    await mk('TEST-14', { parentId: epic.id });
    const rm = await (await req('GET', '/rest/agile/1.0/project/TEST/roadmap', admin)).json() as any;
    const item = rm.items.find((i: any) => i.key === 'TEST-10');
    expect(item.progress).toMatchObject({ children: { done: 1, total: 2 }, percent: 50 });
  });
});
