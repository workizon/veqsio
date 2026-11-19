import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Issues API Integration', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;

  beforeAll(async () => {
    testSql = createTestSql();
    await testSql`SELECT 1`;
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('admin123', 12);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));

    const loginRes = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    cookie = loginRes.headers.get('set-cookie') || '';
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('POST /rest/api/2/issue creates an issue', async () => {
    const res = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Test issue from integration test',
          priority: { id: seeded.priority.id },
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^TEST-\d+$/);
    expect(body.id).toBeDefined();
  });

  test('GET /rest/api/2/issue/:key returns created issue', async () => {
    const createRes = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Fetch me',
        },
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/rest/api/2/issue/${created.key}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe(created.key);
    expect(body.fields.summary).toBe('Fetch me');
  });

  test('PUT /rest/api/2/issue/:key updates an issue', async () => {
    const createRes = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Before update',
        },
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/rest/api/2/issue/${created.key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: { summary: 'After update' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fields.summary).toBe('After update');
  });

  test('DELETE /rest/api/2/issue/:key removes an issue', async () => {
    const createRes = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Delete me',
        },
      }),
    });
    const created = await createRes.json();

    const delRes = await app.request(`/rest/api/2/issue/${created.key}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`/rest/api/2/issue/${created.key}`, {
      headers: { Cookie: cookie },
    });
    expect(getRes.status).toBe(404);
  });

  test('GET /rest/api/2/issue/:key/comment returns empty comments', async () => {
    const createRes = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Comment test',
        },
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/rest/api/2/issue/${created.key}/comment`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toBeDefined();
    expect(body.total).toBe(0);
  });

  test('POST /rest/api/2/issue/:key/comment adds a comment', async () => {
    const createRes = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fields: {
          project: { id: seeded.project.id },
          issuetype: { id: seeded.issueType.id },
          summary: 'Comment add test',
        },
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/rest/api/2/issue/${created.key}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ body: 'Nice work!' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.body).toBe('Nice work!');
  });
  test('POST /rest/api/2/project validates the key, rejects duplicates and sets the project up for use', async () => {
    const post = (body: unknown) => app.request('/rest/api/2/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    });
    expect((await post({ key: 'x', name: 'Bad key' })).status).toBe(400);
    expect((await post({ key: 'NEWP', name: '' })).status).toBe(400);

    const ok = await post({ key: 'newp', name: 'New Project', description: 'First' });
    expect(ok.status).toBe(201);
    const created = await ok.json();
    expect(created.key).toBe('NEWP');

    const dup = await post({ key: 'NEWP', name: 'Again' });
    expect(dup.status).toBe(409);

    // The project is immediately usable: an issue can be created and gets the first key.
    const issue = await app.request('/rest/api/2/issue', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ fields: { project: { id: created.id }, issuetype: { id: seeded.issueType.id }, summary: 'First issue' } }),
    });
    expect(issue.status).toBe(201);
    expect((await issue.json()).key).toBe('NEWP-1');
  });
});
