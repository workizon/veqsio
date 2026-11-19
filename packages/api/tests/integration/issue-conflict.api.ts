import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Concurrent edits of the description', () => {
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let key: string;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const put = (fields: object, expect?: object) => call('PUT', `/rest/api/2/issue/${key}`, { fields, ...(expect ? { expect } : {}) });
  const current = async () => (await (await call('GET', `/rest/api/2/issue/${key}`)).json()).fields.description;

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    key = (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Conflict', description: 'original', priority: { id: seeded.priority.id } } })).json()).key;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('a save based on the current text succeeds', async () => {
    expect((await put({ description: 'first edit' }, { description: 'original' })).status).toBe(200);
    expect(await current()).toBe('first edit');
  });

  test('a save based on an outdated text is refused with the current value', async () => {
    const res = await put({ description: 'mine' }, { description: 'original' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toMatchObject({ field: 'description', current: 'first edit' });
    expect(await current()).toBe('first edit'); // nothing was overwritten
  });

  test('without an expectation the old last-write-wins behaviour stays', async () => {
    expect((await put({ description: 'forced' })).status).toBe(200);
    expect(await current()).toBe('forced');
    // fields that are not sent are not compared
    expect((await put({ summary: 'New title' }, { description: 'stale' })).status).toBe(200);
  });
});
