import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Dashboard gadget data', () => {
  let seeded: any; let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (path: string, body?: unknown, ck = cookie) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) });
  const P = '/rest/api/2/dashboard/gadget-data';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    cookie = (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).headers.get('set-cookie') || '';
    for (const summary of ['one', 'two', 'three']) {
      await app.request('/rest/api/2/issue', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary, assignee: { id: seeded.user.id } } }) });
    }
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs login, a known type and valid input', async () => {
    expect((await app.request(P, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await call(P, { type: 'velocity', config: {} })).status).toBe(400);
    expect((await call(P, { type: 'workload', config: { limit: 0 } })).status).toBe(400);
    expect((await call(P, { type: 'workload', config: { jql: 'nonsense ???' } })).status).toBe(400);
  });

  test('statistics, workload, number tile, heat map and table over real issues', async () => {
    const w = await (await call(P, { type: 'workload', config: { jql: 'project = TEST' } })).json();
    expect(w.buckets[0].value).toBe(3);
    const s = await (await call(P, { type: 'issue-statistics', config: { field: 'status' } })).json();
    expect(s.total).toBe(3);
    const st = await (await call(P, { type: 'stat', config: { jql: 'resolution = Unresolved', compare: true, days: 7 } })).json();
    expect(st.total).toBe(3);
    expect(st.current).toBe(3);
    const h = await (await call(P, { type: 'created-heatmap', config: { days: 30 } })).json();
    expect(h.days.length).toBe(30);
    expect(h.total).toBe(3);
    const t = await (await call(P, { type: 'two-dimensional', config: { field: 'assignee', field2: 'status' } })).json();
    expect(t.total).toBe(3);
    const r = await (await call(P, { type: 'recently-created', config: { limit: 2 } })).json();
    expect(r.issues.length).toBe(2);
    expect(r.total).toBe(3);
  });
});
