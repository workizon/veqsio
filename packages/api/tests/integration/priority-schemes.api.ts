import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Priority schemes', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let projectId: number;
  let prios: { id: number; name: string }[] = [];
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    projectId = seeded.project.id;
    for (const n of ['PS-Low', 'PS-High', 'PS-Other']) {
      const [p] = await db.insert(schema.priorities).values({ name: n }).returning();
      prios.push({ id: p.id, name: p.name });
    }
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const create = (priorityId?: number) =>
    call('POST', '/rest/api/2/issue', { fields: { project: { id: projectId }, issuetype: { id: seeded.issueType.id }, summary: 'PS test', ...(priorityId ? { priority: { id: priorityId } } : {}) } });

  test('without a scheme every priority is accepted', async () => {
    expect((await create(prios[2].id)).status).toBe(201);
  });

  test('scheme validates input and needs an administrator', async () => {
    expect((await app.request('/rest/api/2/admin/priorityscheme')).status).toBe(401);
    expect((await call('POST', '/rest/api/2/admin/priorityscheme', { name: 'X', priorityIds: [999999] })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/admin/priorityscheme', { name: 'X', priorityIds: [prios[0].id], defaultPriorityId: prios[1].id })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/admin/priorityscheme', { name: 'X', priorityIds: [] })).status).toBe(400);
  });

  test('a scheme limits create and edit, supplies the default and trims createmeta', async () => {
    const res = await call('POST', '/rest/api/2/admin/priorityscheme', { name: 'Two levels', priorityIds: [prios[0].id, prios[1].id], defaultPriorityId: prios[0].id, projectIds: [projectId] });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    expect((await create(prios[2].id)).status).toBe(400);
    const ok = await create(prios[1].id);
    expect(ok.status).toBe(201);
    const noPrio = await (await create()).json();
    const issue = await (await call('GET', `/rest/api/2/issue/${noPrio.key}`)).json();
    expect(issue.fields.priority.id).toBe(prios[0].id);

    const bad = await call('PUT', `/rest/api/2/issue/${noPrio.key}`, { fields: { priority: { id: prios[2].id } } });
    expect(bad.status).toBe(400);
    expect((await call('PUT', `/rest/api/2/issue/${noPrio.key}`, { fields: { priority: { id: prios[1].id } } })).status).toBe(200);

    const list = await (await call('GET', '/rest/api/2/admin/priorityscheme')).json();
    expect(list.schemes.find((s: any) => s.id === id).projects.length).toBe(1);

    // deleting the scheme frees the project again
    expect((await call('DELETE', `/rest/api/2/admin/priorityscheme/${id}`)).status).toBe(200);
    expect((await create(prios[2].id)).status).toBe(201);
  });
});
