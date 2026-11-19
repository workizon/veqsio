import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Issue types admin', () => {
  let seeded: any; let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const P = '/rest/api/2/admin/issuetype';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs an administrator and validates', async () => {
    expect((await app.request(P)).status).toBe(401);
    expect((await call('POST', P, { name: '' })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', color: 'red' })).status).toBe(400);
  });

  test('create, list, duplicate name, rename, delete', async () => {
    const r = await call('POST', P, { name: 'Change request', description: 'ITIL change', color: '#aa3300' });
    expect(r.status).toBe(201);
    const t = await r.json();
    expect(t).toMatchObject({ name: 'Change request', subtask: false, color: '#aa3300' });
    expect((await call('POST', P, { name: 'change REQUEST' })).status).toBe(409);
    const list = await (await call('GET', P)).json();
    expect(list.issueTypes.some((x: any) => x.id === t.id)).toBe(true);
    // visible to the normal metadata endpoint, including after the cache was warm
    const meta = await (await call('GET', '/rest/api/2/issuetype')).json();
    expect(meta.some((x: any) => x.name === 'Change request')).toBe(true);
    expect((await (await call('PUT', `${P}/${t.id}`, { name: 'Change', subtask: false, color: '#aa3300' })).json()).name).toBe('Change');
    expect((await call('DELETE', `${P}/${t.id}`)).status).toBe(204);
    expect((await call('DELETE', `${P}/${t.id}`)).status).toBe(404);
  });

  test('a type in use cannot be deleted or change its sub-task flag', async () => {
    const used = seeded.issueType.id;
    const issue = await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: used }, summary: 'uses type' } });
    expect(issue.status).toBe(201);
    expect((await call('DELETE', `${P}/${used}`)).status).toBe(409);
    const cur = (await (await call('GET', P)).json()).issueTypes.find((x: any) => x.id === used);
    expect((await call('PUT', `${P}/${used}`, { name: cur.name, subtask: !cur.subtask, color: cur.color })).status).toBe(409);
  });
});
