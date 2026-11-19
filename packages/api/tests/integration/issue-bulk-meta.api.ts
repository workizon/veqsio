import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Issue bulk create and createmeta', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const fields = (summary: string) => ({ fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary, priority: { id: seeded.priority.id } } });

  test('creates several issues and reports per-element failures', async () => {
    const res = await call('POST', '/rest/api/2/issue/bulk', { issueUpdates: [fields('One'), { fields: { project: { id: 999999 }, issuetype: { id: seeded.issueType.id }, summary: 'Nope' } }, fields('Three')] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.issues.length).toBe(2);
    expect(body.issues[0].key).toMatch(/^TEST-\d+$/);
    expect(body.errors.length).toBe(1);
    expect(body.errors[0].failedElementNumber).toBe(1);
  });

  test('validates the request body', async () => {
    expect((await call('POST', '/rest/api/2/issue/bulk', {})).status).toBe(400);
    expect((await call('POST', '/rest/api/2/issue/bulk', { issueUpdates: [] })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/issue/bulk', { issueUpdates: Array(51).fill(fields('x')) })).status).toBe(400);
  });

  test('createmeta lists projects, issue types and fields', async () => {
    const res = await call('GET', '/rest/api/2/issue/createmeta?projectKeys=test&expand=projects.issuetypes.fields');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects[0].key).toBe('TEST');
    const t = body.projects[0].issuetypes.find((x: any) => x.id === String(seeded.issueType.id));
    expect(t.fields.summary.required).toBe(true);
    expect(t.fields.priority.allowedValues.length).toBeGreaterThan(0);
    const plain = await (await call('GET', '/rest/api/2/issue/createmeta')).json();
    expect(plain.projects[0].issuetypes[0].fields).toBeUndefined();
    expect((await app.request('/rest/api/2/issue/createmeta')).status).toBe(401);
  });
});
