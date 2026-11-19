import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Story points API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let cookie: string;
  let boardId: number;
  let sprintId: number;
  const day = 86_400_000;
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const create = (fields: Record<string, unknown>) =>
    json('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'sp', ...fields } });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw-123456' }),
    });
    cookie = login.headers.get('set-cookie') || '';
    // The in-memory rate limiter is shared by every file in all.test.ts; start from a clean window.
    await redis.del(`veqsio:ratelimit:user:${seeded.user.id}`, 'veqsio:ratelimit:ip:unknown');
    const start = Date.now() - 4 * day;
    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id }).returning();
    boardId = board.id;
    const [sprint] = await db.insert(schema.sprints).values({
      name: 'S1', state: 'closed', boardId, startDate: new Date(start), endDate: new Date(start + 4 * day), completeDate: new Date(start + 4 * day),
    }).returning();
    sprintId = sprint.id;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('create, read, update, clear and history', async () => {
    const res = await create({ storyPoints: 5 });
    expect(res.status).toBe(201);
    const { key } = await res.json();
    let issue = await (await json('GET', `/rest/api/2/issue/${key}`)).json();
    expect(issue.fields.storyPoints).toBe(5);

    expect((await json('PUT', `/rest/api/2/issue/${key}`, { fields: { storyPoints: 8.5 } })).status).toBe(200);
    issue = await (await json('GET', `/rest/api/2/issue/${key}`)).json();
    expect(issue.fields.storyPoints).toBe(8.5);

    expect((await json('PUT', `/rest/api/2/issue/${key}`, { fields: { storyPoints: null } })).status).toBe(200);
    issue = await (await json('GET', `/rest/api/2/issue/${key}`)).json();
    expect(issue.fields.storyPoints).toBeNull();

    const hist = await (await json('GET', `/rest/api/2/issue/${key}/changelog`)).json();
    const rows = JSON.stringify(hist);
    expect(rows).toContain('storypoints');
    expect(rows).toContain('8.5');
  });

  test('validates range, decimals and type', async () => {
    for (const bad of [-1, 1000.01, 1.234, '5']) {
      expect((await create({ storyPoints: bad })).status).toBe(400);
    }
    const { key } = await (await create({})).json();
    for (const bad of [-0.5, 1001, 2.005, 'abc']) {
      expect((await json('PUT', `/rest/api/2/issue/${key}`, { fields: { storyPoints: bad } })).status).toBe(400);
    }
    expect((await create({ storyPoints: 1000 })).status).toBe(201);
    expect((await create({ storyPoints: 0.25 })).status).toBe(201);
  });

  test('reports support unit=points and count unestimated issues', async () => {
    const db = createTestDb(testSql);
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done' }).returning();
    const start = Date.now() - 4 * day;
    const pts: Array<string | null> = ['3.00', '5.00', null];
    for (let n = 0; n < 3; n++) {
      const [issue] = await db.insert(schema.issues).values({
        issueKey: `PTS-${n + 1}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id,
        statusId: n < 2 ? done.id : seeded.status.id, summary: `p${n}`, reporterId: seeded.user.id,
        createdAt: new Date(start - day), storyPoints: pts[n],
      }).returning();
      await db.insert(schema.sprintIssues).values({ sprintId, issueId: issue.id });
      if (n < 2) {
        await db.insert(schema.issueHistory).values({ issueId: issue.id, fieldName: 'status', oldValue: 'To Do', newValue: 'Done', createdAt: new Date(start + 2 * day) });
      }
    }
    const get = async (p: string) => (await app.request(p, { headers: { Cookie: cookie } })).json() as Promise<any>;
    const base = `/rest/agile/1.0/board/${boardId}/report`;
    const sprint = await get(`${base}/sprint?sprintId=${sprintId}&unit=points`);
    expect(sprint).toMatchObject({ unit: 'points', committed: 8, completed: 8, incomplete: 0, unestimated: 1 });
    const burn = await get(`${base}/burndown?sprintId=${sprintId}&unit=points`);
    expect(burn).toMatchObject({ unit: 'points', total: 8, unestimated: 1 });
    const vel = await get(`${base}/velocity?unit=points`);
    expect(vel).toMatchObject({ unit: 'points', unestimated: 1 });
    expect(vel.sprints[0].completed).toBe(8);
    const epics = await get(`${base}/epics?unit=points`);
    expect(epics).toMatchObject({ unit: 'points', unestimated: 0 });
    const units = await get(`${base}/units`);
    expect(units).toEqual({ hasPoints: true, defaultUnit: 'points' });
    // unknown unit falls back to issue count
    expect((await get(`${base}/sprint?sprintId=${sprintId}&unit=bogus`)).committed).toBe(3);
  });
});
