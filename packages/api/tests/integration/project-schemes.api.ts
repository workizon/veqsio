import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Project schemes tab', () => {
  let seeded: any; let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  let key: string;

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    key = seeded.project.projectKey;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs login and a known project', async () => {
    expect((await app.request(`/rest/api/2/project/${key}/schemes`)).status).toBe(401);
    expect((await call('GET', '/rest/api/2/project/NOPE/schemes')).status).toBe(404);
  });

  test('lists all five kinds; priority scheme can be set and cleared, security is read-only', async () => {
    const before = await (await call('GET', `/rest/api/2/project/${key}/schemes`)).json();
    expect(before.schemes.map((s: any) => s.kind)).toEqual(['issuetype', 'workflow', 'permission', 'priority', 'security']);
    expect(before.schemes.find((s: any) => s.kind === 'security').editable).toBe(false);
    const [{ id: pid }] = await createTestDb(testSql).insert(schema.priorities).values({ name: 'Tab-P' }).returning();
    const sch = await call('POST', '/rest/api/2/admin/priorityscheme', { name: 'Tab test', priorityIds: [pid] });
    expect(sch.status).toBe(201);
    const { id } = await sch.json();
    const set = await (await call('PUT', `/rest/api/2/project/${key}/schemes`, { kind: 'priority', schemeId: id })).json();
    expect(set.schemes.find((s: any) => s.kind === 'priority').current).toBe('Tab test');
    const cleared = await (await call('PUT', `/rest/api/2/project/${key}/schemes`, { kind: 'priority', schemeId: null })).json();
    expect(cleared.schemes.find((s: any) => s.kind === 'priority').currentId).toBeNull();
  });

  test('rejects clearing a required scheme, unknown schemes and the security kind', async () => {
    expect((await call('PUT', `/rest/api/2/project/${key}/schemes`, { kind: 'workflow', schemeId: null })).status).toBe(400);
    expect((await call('PUT', `/rest/api/2/project/${key}/schemes`, { kind: 'workflow', schemeId: 999999 })).status).toBe(404);
    expect((await call('PUT', `/rest/api/2/project/${key}/schemes`, { kind: 'security', schemeId: 1 })).status).toBe(400);
  });
});
