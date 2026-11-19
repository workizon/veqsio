import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Teamspaces', () => {
  let seeded: any; let cookie: string; let bob: { id: number }; let bobCookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const as = (ck: string) => (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
  let call: ReturnType<typeof as>; let callBob: ReturnType<typeof as>;
  const P = '/rest/api/2/teamspace';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    [bob] = await db.insert(schema.users).values({ username: 'tsbob', email: 'tsbob@example.com', displayName: 'Bob', active: true, passwordHash: await bcrypt.hash('bob12345', 12) }).returning();
    const login = async (u: string, p: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie') || '';
    cookie = await login('admin', 'admin123'); bobCookie = await login('tsbob', 'bob12345');
    call = as(cookie); callBob = as(bobCookie);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs login and validates', async () => {
    expect((await app.request(P)).status).toBe(401);
    expect((await call('POST', P, { name: '' })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', memberIds: [999999] })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', projectIds: [999999] })).status).toBe(400);
  });

  test('create, stats with real issues, duplicate name, edit rights', async () => {
    await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Team work', assignee: { id: bob.id } } });
    await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Nobody has it' } });
    const r = await call('POST', P, { name: 'Platform', description: 'Core team', memberIds: [bob.id], projectIds: [seeded.project.id] });
    expect(r.status).toBe(201);
    const { id } = await r.json();
    expect((await call('POST', P, { name: 'platform' })).status).toBe(409);

    const d = await (await call('GET', `${P}/${id}`)).json();
    expect(d.members.map((m: any) => m.id)).toEqual([bob.id]);
    expect(d.projects.length).toBe(1);
    expect(d.stats.open).toBeGreaterThanOrEqual(2);
    expect(d.stats.unassigned).toBeGreaterThanOrEqual(1);
    expect(d.stats.byMember.find((x: any) => x.userId === bob.id).open).toBe(1);
    expect(d.jql).toContain(`project in (${seeded.project.projectKey})`);
    expect(d.canEdit).toBe(true);

    const list = await (await call('GET', P)).json();
    expect(list.teamspaces.find((t: any) => t.id === id)).toMatchObject({ members: 1, projects: 1 });

    // Bob (a plain user, not lead or creator) can read it but not change it
    expect((await callBob('GET', `${P}/${id}`)).status).toBe(200);
    expect((await callBob('PUT', `${P}/${id}`, { name: 'Hijack' })).status).toBe(403);
    expect((await callBob('DELETE', `${P}/${id}`)).status).toBe(403);

    expect((await call('PUT', `${P}/${id}`, { name: 'Platform team', memberIds: [], projectIds: [] })).status).toBe(200);
    const after = await (await call('GET', `${P}/${id}`)).json();
    expect(after).toMatchObject({ name: 'Platform team', jql: null });
    expect((await call('DELETE', `${P}/${id}`)).status).toBe(204);
    expect((await call('GET', `${P}/${id}`)).status).toBe(404);
  });
});
