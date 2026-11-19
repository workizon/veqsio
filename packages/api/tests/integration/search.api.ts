import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Search API Integration', () => {
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

    // Seed a few issues
    for (let i = 0; i < 3; i++) {
      await app.request('/rest/api/2/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          fields: {
            project: { id: seeded.project.id },
            issuetype: { id: seeded.issueType.id },
            summary: `Searchable issue ${i}`,
          },
        }),
      });
    }
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('GET /rest/api/2/search returns issues', async () => {
    const res = await app.request('/rest/api/2/search', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toBeDefined();
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  test('GET /rest/api/2/search with jql text search filters results', async () => {
    const res = await app.request('/rest/api/2/search?jql=text+~+%22Searchable+issue+1%22', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /rest/api/2/search respects startAt and maxResults', async () => {
    const res = await app.request('/rest/api/2/search?startAt=0&maxResults=1', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxResults).toBe(1);
    expect(body.startAt).toBe(0);
  });
  const jql = (q: string) =>
    app.request(`/rest/api/2/search?jql=${encodeURIComponent(q)}&maxResults=50`, { headers: { Cookie: cookie } });

  test('JQL: an unknown status name matches nothing instead of failing', async () => {
    let res = await jql('status = "No Such Status"');
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(0);

    // Unknown names inside NOT IN are ignored, so every issue still matches.
    res = await jql('status not in ("No Such Status", "Another Missing")');
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(3);
  });

  test('JQL: date comparisons accept quoted dates and reject invalid ones with 400', async () => {
    const res = await jql('created >= "2000-01-01"');
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(3);

    const future = await jql('created >= "2999-01-01"');
    expect(future.status).toBe(200);
    expect((await future.json()).total).toBe(0);

    const bad = await jql('created >= "not-a-date"');
    expect(bad.status).toBe(400);
  });
  test('JQL: sprint, parent and relative date clauses (used by the backlog and dashboards)', async () => {
    const db = createTestDb(testSql);
    const [board] = await db.insert(schema.boards).values({ name: 'JQL board', type: 'scrum', projectId: seeded.project.id }).returning();
    const [sprint] = await db.insert(schema.sprints).values({ name: 'Sprint X', state: 'active', boardId: board.id }).returning();
    const rows = await db.select().from(schema.issues).orderBy(schema.issues.id);
    await db.insert(schema.sprintIssues).values({ sprintId: sprint.id, issueId: rows[0].id });
    await db.update(schema.issues).set({ parentId: rows[0].id }).where(eq(schema.issues.id, rows[1].id));

    const total = async (q: string) => {
      const res = await jql(q);
      expect(res.status).toBe(200);
      return (await res.json()).total as number;
    };
    expect(await total(`sprint = ${sprint.id}`)).toBe(1);
    expect(await total('sprint = "sprint x"')).toBe(1);
    expect(await total(`sprint in (${sprint.id}, 99999)`)).toBe(1);
    expect(await total('sprint is EMPTY')).toBe(rows.length - 1);
    expect(await total('sprint is not EMPTY')).toBe(1);
    expect(await total('sprint != "Sprint X"')).toBe(rows.length - 1);
    expect(await total('sprint = "No Such Sprint"')).toBe(0);
    expect(await total('sprint is EMPTY ORDER BY priority DESC, created DESC')).toBe(rows.length - 1);

    expect(await total(`parent = ${rows[0].issueKey}`)).toBe(1);
    expect(await total(`parent in (${rows[0].issueKey}, NOPE-1)`)).toBe(1);
    expect(await total('parent = NOPE-1')).toBe(0);
    expect(await total('parent is EMPTY')).toBe(rows.length - 1);
    expect(await total('parent is not EMPTY')).toBe(1);

    expect(await total('updated >= -1d')).toBe(rows.length);
    expect(await total('created <= -1d')).toBe(0);
    expect(await total('created >= -2w AND created <= 1h')).toBe(rows.length);
  });
});
