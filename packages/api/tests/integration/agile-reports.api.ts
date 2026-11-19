import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Agile reports API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let cookie: string;
  let boardId: number;
  let sprintId: number;
  const day = 86_400_000;

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw-123456' }),
    });
    cookie = login.headers.get('set-cookie') || '';

    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done' }).returning();
    const start = Date.now() - 4 * day;
    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id }).returning();
    boardId = board.id;
    const [sprint] = await db.insert(schema.sprints).values({
      name: 'Sprint 1', state: 'closed', boardId, startDate: new Date(start), endDate: new Date(start + 4 * day), completeDate: new Date(start + 4 * day),
    }).returning();
    sprintId = sprint.id;

    for (let n = 1; n <= 3; n++) {
      const [issue] = await db.insert(schema.issues).values({
        issueKey: `TEST-${n}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id,
        statusId: n === 3 ? seeded.status.id : done.id, summary: `s${n}`, reporterId: seeded.user.id,
        createdAt: new Date(start - day),
      }).returning();
      await db.insert(schema.sprintIssues).values({ sprintId, issueId: issue.id });
      if (n < 3) {
        await db.insert(schema.issueHistory).values([
          { issueId: issue.id, fieldName: 'status', oldValue: 'To Do', newValue: 'In Progress', createdAt: new Date(start + day) },
          { issueId: issue.id, fieldName: 'status', oldValue: 'In Progress', newValue: 'Done', createdAt: new Date(start + (n + 1) * day) },
        ]);
      }
    }
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const get = (path: string) => app.request(path, { headers: { Cookie: cookie } });

  test('burndown goes down as issues complete', async () => {
    const res = await get(`/rest/agile/1.0/board/${boardId}/report/burndown?sprintId=${sprintId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.points[0].remaining).toBe(3);
    expect(body.points.at(-1).remaining).toBe(1);
  });

  test('sprint report and velocity', async () => {
    let body = await (await get(`/rest/agile/1.0/board/${boardId}/report/sprint?sprintId=${sprintId}`)).json();
    expect(body).toMatchObject({ committed: 3, completed: 2, incomplete: 1 });
    body = await (await get(`/rest/agile/1.0/board/${boardId}/report/velocity`)).json();
    expect(body.sprints).toHaveLength(1);
    expect(body.averageVelocity).toBe(2);
  });

  test('cfd and control chart respond', async () => {
    const cfd = await (await get(`/rest/agile/1.0/board/${boardId}/report/cfd?days=7`)).json();
    expect(cfd.points.at(-1)).toMatchObject({ done: 2, todo: 1 });
    const control = await (await get(`/rest/agile/1.0/board/${boardId}/report/control?days=30`)).json();
    expect(control.points).toHaveLength(2);
  });

  test('requires auth and a real board', async () => {
    expect((await app.request(`/rest/agile/1.0/board/${boardId}/report/cfd`)).status).toBe(401);
    expect((await get('/rest/agile/1.0/board/99999/report/cfd')).status).toBe(404);
  });
});
