import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Comment reactions', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let key: string;
  let commentId: string;

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
    const created = await (await call('POST', '/rest/api/2/issue', {
      fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Reactions', priority: { id: seeded.priority.id } },
    })).json();
    key = created.key;
    commentId = (await (await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'hello' })).json()).id;
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  const reactions = async () => (await (await call('GET', `/rest/api/2/issue/${key}/comment`)).json()).comments[0].reactions;

  test('toggling adds then removes a reaction and lists counts', async () => {
    const on = await call('POST', `/rest/api/2/issue/${key}/comment/${commentId}/reaction`, { emoji: '👍' });
    expect(on.status).toBe(200);
    expect((await on.json()).active).toBe(true);
    expect(await reactions()).toEqual([{ emoji: '👍', count: 1, me: true }]);
    const off = await call('POST', `/rest/api/2/issue/${key}/comment/${commentId}/reaction`, { emoji: '👍' });
    expect((await off.json()).active).toBe(false);
    expect(await reactions()).toEqual([]);
  });

  test('rejects unknown emoji, bad bodies and unknown comments', async () => {
    expect((await call('POST', `/rest/api/2/issue/${key}/comment/${commentId}/reaction`, { emoji: '<script>' })).status).toBe(400);
    expect((await call('POST', `/rest/api/2/issue/${key}/comment/${commentId}/reaction`, {})).status).toBe(400);
    expect((await call('POST', `/rest/api/2/issue/${key}/comment/999999/reaction`, { emoji: '👍' })).status).toBe(404);
  });
});
