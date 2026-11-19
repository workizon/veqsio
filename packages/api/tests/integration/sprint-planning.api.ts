import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Sprint planning API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let adminCookie: string;
  let devCookie: string;
  let boardId: number;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  const day = 86_400_000;
  const base = '/rest/agile/1.0';
  const keyId: Record<string, number> = {};
  const ids: { s1?: number; s2?: number; s3?: number } = {};

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const admin = (m: string, p: string, b?: unknown) => call(adminCookie, m, p, b);
  const dev = (m: string, p: string, b?: unknown) => call(devCookie, m, p, b);
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  const sprintKeys = async (sprintId: number) =>
    ((await (await admin('GET', `${base}/sprint/${sprintId}/issue`)).json()).issues as Array<{ key: string }>).map((i) => i.key);
  const backlogKeys = async () =>
    ((await (await admin('GET', `${base}/board/${boardId}/backlog?maxResults=100`)).json()).issues as Array<{ key: string }>).map((i) => i.key);

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [devUser] = await db.insert(schema.users).values({
      username: 'dev', email: 'dev@veqsio.local', displayName: 'Dev User', passwordHash: hash,
    }).returning();
    // dev may browse the project but has no MANAGE_SPRINTS
    await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: devUser.id });
    adminCookie = await login('admin');
    devCookie = await login('dev');

    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done' }).returning();
    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTH', name: 'Other', leadId: seeded.user.id }).returning();
    const [board] = await db.insert(schema.boards).values({ name: 'Scrum', type: 'scrum', projectId: seeded.project.id }).returning();
    boardId = board.id;
    const [sp] = await db.insert(schema.customFields).values({ name: 'Story Points', fieldType: 'number' }).returning();

    const mk = async (key: string, projectId: number, statusId: number, points?: number) => {
      const [i] = await db.insert(schema.issues).values({
        issueKey: key, projectId, issueTypeId: seeded.issueType.id, statusId, summary: `Issue ${key}`,
        reporterId: seeded.user.id, priorityId: seeded.priority.id, createdAt: new Date(Date.now() - 5 * day),
      }).returning();
      keyId[key] = i.id;
      if (points !== undefined) await db.insert(schema.customFieldValues).values({ issueId: i.id, customFieldId: sp.id, numberValue: String(points) });
    };
    await mk('TEST-1', seeded.project.id, done.id, 3);
    await mk('TEST-2', seeded.project.id, seeded.status2.id, 5);
    await mk('TEST-3', seeded.project.id, seeded.status.id, 2);
    await mk('TEST-4', seeded.project.id, seeded.status.id);
    await mk('TEST-5', seeded.project.id, done.id, 8); // done issues stay out of the backlog
    await mk('OTH-1', other.id, seeded.status.id, 1);
  });
  afterAll(async () => {
    // This suite is request-heavy: leave the shared per-user rate-limit budget intact for later files.
    const keys = await redis.keys('veqsio:ratelimit:*');
    if (keys.length) await redis.del(...keys);
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('create validates input and denies users without MANAGE_SPRINTS', async () => {
    expect((await admin('POST', `${base}/board/${boardId}/sprint`, { name: '  ' })).status).toBe(400);
    expect((await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'x', startDate: iso(2), endDate: iso(1) })).status).toBe(400);
    expect((await dev('POST', `${base}/board/${boardId}/sprint`, { name: 'Nope' })).status).toBe(403);
    const r1 = await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Sprint 1', goal: 'Ship it', startDate: iso(-3), endDate: iso(10) });
    expect(r1.status).toBe(201);
    ids.s1 = (await r1.json()).id;
    ids.s2 = (await (await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Sprint 2', startDate: iso(10), endDate: iso(24) })).json()).id;
    ids.s3 = (await (await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Undated' })).json()).id;
  });

  test('backlog lists open work of the board project, without done issues', async () => {
    const res = await admin('GET', `${base}/board/${boardId}/backlog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.map((i: any) => i.key).sort()).toEqual(['TEST-2', 'TEST-3', 'TEST-4']);
    expect(body.total).toBe(3);
    expect(body.storyPoints).toBe(7);
    const withDone = await (await admin('GET', `${base}/board/${boardId}/backlog?includeDone=true`)).json();
    expect(withDone.total).toBe(5);
    const paged = await (await admin('GET', `${base}/board/${boardId}/backlog?maxResults=1&startAt=1`)).json();
    expect(paged.issues).toHaveLength(1);
    expect(paged.total).toBe(3);
  });

  test('move issues into a sprint, rank them, and out of the backlog', async () => {
    const res = await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['TEST-1', 'test-2', 'TEST-3'] });
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(3);
    expect(await sprintKeys(ids.s1!)).toEqual(['TEST-1', 'TEST-2', 'TEST-3']);
    expect(await backlogKeys()).toEqual(['TEST-4']);

    // Rank TEST-3 first
    await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['TEST-3'], rankBeforeIssue: 'TEST-1' });
    expect(await sprintKeys(ids.s1!)).toEqual(['TEST-3', 'TEST-1', 'TEST-2']);

    const sprintIssues = await (await admin('GET', `${base}/sprint/${ids.s1}/issue`)).json();
    expect(sprintIssues.total).toBe(3);
    expect(sprintIssues.issues[1].fields.storyPoints).toBe(3);
    expect(sprintIssues.issues[1].fields.status.statusCategory.key).toBe('done');
  });

  test('planning view returns sprints with issues and totals in one call', async () => {
    const body = await (await admin('GET', `${base}/board/${boardId}/planning`)).json();
    const s1 = body.sprints.find((s: any) => s.id === ids.s1);
    expect(s1.issueCount).toBe(3);
    expect(s1.storyPoints).toBe(10);
    expect(s1.issues).toHaveLength(3);
    expect(body.backlog.total).toBe(1);
    expect(body.board.allowParallelSprints).toBe(true);
  });

  test('moving to another sprint removes the issue from the first one', async () => {
    expect((await admin('POST', `${base}/sprint/${ids.s2}/issue`, { issues: ['TEST-3'] })).status).toBe(200);
    expect(await sprintKeys(ids.s1!)).toEqual(['TEST-1', 'TEST-2']);
    expect(await sprintKeys(ids.s2!)).toEqual(['TEST-3']);
  });

  test('move back to the backlog', async () => {
    const res = await admin('POST', `${base}/backlog/issue`, { issues: ['TEST-3'] });
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toBe(1);
    expect(await sprintKeys(ids.s2!)).toEqual([]);
    expect((await backlogKeys()).sort()).toEqual(['TEST-3', 'TEST-4']);
  });

  test('ranks issues inside the backlog', async () => {
    const order = async () => (await backlogKeys());
    const res = await admin('POST', `${base}/backlog/issue`, { issues: ['TEST-4'], rankBeforeIssue: 'TEST-3' });
    expect(res.status).toBe(200);
    expect((await order()).indexOf('TEST-4')).toBeLessThan((await order()).indexOf('TEST-3'));
    expect((await admin('POST', `${base}/backlog/issue`, { issues: ['TEST-4'], rankAfterIssue: 'TEST-3' })).status).toBe(200);
    expect((await order()).indexOf('TEST-3')).toBeLessThan((await order()).indexOf('TEST-4'));
    // anchor outside the backlog / project is rejected
    expect((await admin('POST', `${base}/backlog/issue`, { issues: ['TEST-4'], rankBeforeIssue: 'OTH-1' })).status).toBe(400);
    expect((await dev('POST', `${base}/backlog/issue`, { issues: ['TEST-4'], rankBeforeIssue: 'TEST-3' })).status).toBe(403);
  });

  test('rejects issues of another project, unknown keys and bad bodies', async () => {
    const cross = await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['OTH-1'] });
    expect(cross.status).toBe(400);
    expect((await cross.json()).errorMessages[0]).toContain('different project');
    expect(await sprintKeys(ids.s1!)).toEqual(['TEST-1', 'TEST-2']);
    expect((await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['NOPE-9'] })).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: [] })).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/${ids.s1}/issue`, {})).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/99999/issue`, { issues: ['TEST-4'] })).status).toBe(404);
  });

  test('users without MANAGE_SPRINTS cannot move, start, complete or delete; browsing works', async () => {
    expect((await dev('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['TEST-4'] })).status).toBe(403);
    expect((await dev('POST', `${base}/backlog/issue`, { issues: ['TEST-1'] })).status).toBe(403);
    expect((await dev('POST', `${base}/sprint/${ids.s1}/start`, {})).status).toBe(403);
    expect((await dev('POST', `${base}/sprint/${ids.s1}/complete`, {})).status).toBe(403);
    expect((await dev('DELETE', `${base}/sprint/${ids.s3}`)).status).toBe(403);
    expect(await sprintKeys(ids.s1!)).toEqual(['TEST-1', 'TEST-2']);
    expect((await dev('GET', `${base}/board/${boardId}/planning`)).status).toBe(200);
    expect((await dev('GET', `${base}/board/${boardId}/backlog`)).status).toBe(200);
  });

  test('start validates name, dates and state', async () => {
    const noDates = await admin('POST', `${base}/sprint/${ids.s3}/start`, {});
    expect(noDates.status).toBe(400);
    expect((await noDates.json()).errorMessages).toEqual(expect.arrayContaining(['Start date is required', 'End date is required']));
    const inverted = await admin('POST', `${base}/sprint/${ids.s3}/start`, { startDate: iso(5), endDate: iso(1) });
    expect(inverted.status).toBe(400);
    expect((await admin('POST', `${base}/sprint/${ids.s3}/start`, { startDate: 'not-a-date' })).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/99999/start`, {})).status).toBe(404);

    const ok = await admin('POST', `${base}/sprint/${ids.s1}/start`, {});
    expect(ok.status).toBe(200);
    const started = await ok.json();
    expect(started).toMatchObject({ state: 'active', issueCount: 2, storyPoints: 8, parallelActiveSprints: false, warnings: [] });

    expect((await admin('POST', `${base}/sprint/${ids.s1}/start`, {})).status).toBe(400); // already active
  });

  test('a second active sprint is allowed but flagged, unless the board forbids it', async () => {
    const db = createTestDb(testSql);
    await db.update(schema.boards).set({ config: { allowParallelSprints: false } }).where(eq(schema.boards.id, boardId));
    const denied = await admin('POST', `${base}/sprint/${ids.s2}/start`, {});
    expect(denied.status).toBe(409);
    await db.update(schema.boards).set({ config: {} }).where(eq(schema.boards.id, boardId));
    const res = await admin('POST', `${base}/sprint/${ids.s3}/start`, { startDate: iso(0), endDate: iso(7) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parallelActiveSprints).toBe(true);
    expect(body.warnings[0]).toContain('Sprint 1');
    // finish this helper sprint so later steps have a single active sprint
    expect((await admin('POST', `${base}/sprint/${ids.s3}/complete`, { moveIncompleteTo: 'backlog' })).status).toBe(200);
  });

  test('complete moves incomplete issues to another sprint and keeps done ones', async () => {
    // add a not-done issue mid sprint (scope change flag)
    const add = await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['TEST-4'] });
    expect((await add.json()).scopeChange).toBe(true);

    expect((await admin('POST', `${base}/sprint/${ids.s1}/complete`, { moveIncompleteTo: 'abc' })).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/${ids.s1}/complete`, { moveIncompleteTo: ids.s1 })).status).toBe(400);
    expect((await admin('POST', `${base}/sprint/${ids.s1}/complete`, { moveIncompleteTo: ids.s3 })).status).toBe(400); // closed target

    const res = await admin('POST', `${base}/sprint/${ids.s1}/complete`, { moveIncompleteTo: ids.s2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sprint.state).toBe('closed');
    expect(body.sprint.completeDate).toBeTruthy();
    expect(body.summary).toMatchObject({ completed: 1, moved: 2, completedPoints: 3, movedPoints: 5 });
    expect(body.summary.movedTo).toMatchObject({ type: 'sprint', id: ids.s2 });
    expect(body.summary.completedIssues).toEqual(['TEST-1']);
    expect(body.summary.movedIssues.sort()).toEqual(['TEST-2', 'TEST-4']);

    expect((await sprintKeys(ids.s2!)).sort()).toEqual(['TEST-2', 'TEST-4']);
    expect((await sprintKeys(ids.s1!)).sort()).toEqual(['TEST-1', 'TEST-2', 'TEST-4']); // history kept
    expect((await admin('POST', `${base}/sprint/${ids.s1}/complete`, {})).status).toBe(400); // no longer active
  });

  test('closed sprints reject new issues; reports still compute, also in story points', async () => {
    const res = await admin('POST', `${base}/sprint/${ids.s1}/issue`, { issues: ['TEST-3'] });
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages[0]).toContain('closed');

    const summary = await (await admin('GET', `${base}/board/${boardId}/report/sprint?sprintId=${ids.s1}&unit=points`)).json();
    expect(summary).toMatchObject({ unit: 'points', committed: 8, completed: 3, incomplete: 5 });
    const burndown = await admin('GET', `${base}/board/${boardId}/report/burndown?sprintId=${ids.s1}&unit=points`);
    expect(burndown.status).toBe(200);
    expect((await burndown.json()).total).toBe(8);
    const velocity = await (await admin('GET', `${base}/board/${boardId}/report/velocity?unit=points`)).json();
    expect(velocity.sprints.length).toBeGreaterThanOrEqual(1);
    expect(velocity.sprints.find((s: any) => s.sprintId === ids.s1)).toMatchObject({ completed: 3 });
  });

  test('complete with incomplete issues to the backlog', async () => {
    expect((await admin('POST', `${base}/sprint/${ids.s2}/start`, { startDate: iso(-1), endDate: iso(13) })).status).toBe(200);
    const res = await admin('POST', `${base}/sprint/${ids.s2}/complete`, { moveIncompleteTo: 'backlog' });
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toMatchObject({ completed: 0, moved: 2, movedTo: { type: 'backlog' } });
    expect((await backlogKeys()).sort()).toEqual(['TEST-2', 'TEST-3', 'TEST-4']);
    // an issue returned to the backlog can be planned into a new sprint again
    const r = await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Sprint 4' });
    const s4 = (await r.json()).id;
    expect((await admin('POST', `${base}/sprint/${s4}/issue`, { issues: ['TEST-2'] })).status).toBe(200);
    expect(await sprintKeys(s4)).toEqual(['TEST-2']);
  });

  test('update and delete: only future sprints can be deleted and their issues return to the backlog', async () => {
    const created = await (await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Temp' })).json();
    await admin('POST', `${base}/sprint/${created.id}/issue`, { issues: ['TEST-3'] });
    expect(await backlogKeys()).not.toContain('TEST-3');

    const upd = await admin('PUT', `${base}/sprint/${created.id}`, { name: 'Renamed', goal: 'g' });
    expect(upd.status).toBe(200);
    expect((await upd.json()).name).toBe('Renamed');
    expect((await admin('PUT', `${base}/sprint/${created.id}`, { name: '' })).status).toBe(400);
    expect((await admin('PUT', `${base}/sprint/${ids.s1}`, { name: 'Edit closed' })).status).toBe(400);

    expect((await admin('DELETE', `${base}/sprint/${ids.s1}`)).status).toBe(400); // closed
    expect((await admin('DELETE', `${base}/sprint/${created.id}`)).status).toBe(200);
    expect(await backlogKeys()).toContain('TEST-3');
  });

  test('sprint automation: next sprint is created and unfinished work carried over', async () => {
    const auto = `${base}/board/${boardId}/sprint-automation`;
    expect((await dev('PUT', auto, { autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'next' })).status).toBe(403);
    expect((await admin('PUT', auto, { autoCreateNext: true, durationDays: 0, autoMoveIncomplete: 'next' })).status).toBe(400);
    expect((await admin('PUT', auto, { autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'later' })).status).toBe(400);
    expect((await admin('PUT', auto, { autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'next', extra: 1 })).status).toBe(400);
    expect((await admin('PUT', auto, { autoCreateNext: true, durationDays: 7, autoMoveIncomplete: 'next' })).status).toBe(200);

    const sp = await (await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Auto 5', startDate: iso(0), endDate: iso(7) })).json();
    expect((await admin('POST', `${base}/sprint/${sp.id}/issue`, { issues: ['TEST-3'] })).status).toBe(200);
    expect((await admin('POST', `${base}/sprint/${sp.id}/start`, {})).status).toBe(200);
    const done = await admin('POST', `${base}/sprint/${sp.id}/complete`, {});
    expect(done.status).toBe(200);
    const body = await done.json();
    // a future sprint already exists on this board: it is reused instead of creating another one
    expect(body.summary.createdSprint).toBeNull();
    expect(body.summary.movedTo.type).toBe('sprint');
    expect(await sprintKeys(body.summary.movedTo.id)).toContain('TEST-3');
    // an explicit target wins over the automation default
    await createTestDb(testSql).update(schema.sprints).set({ state: 'closed' }).where(eq(schema.sprints.state, 'future'));
    const sp2 = await (await admin('POST', `${base}/board/${boardId}/sprint`, { name: 'Auto 9', startDate: iso(0), endDate: iso(7) })).json();
    await admin('POST', `${base}/sprint/${sp2.id}/issue`, { issues: ['TEST-4'] });
    await admin('POST', `${base}/sprint/${sp2.id}/start`, {});
    const done2 = await (await admin('POST', `${base}/sprint/${sp2.id}/complete`, { moveIncompleteTo: 'backlog' })).json();
    expect(done2.summary.movedTo).toEqual({ type: 'backlog' });
    expect(done2.summary.createdSprint.name).toBe('Auto 10'); // none was left: created, 7 days long
    const made = ((await (await admin('GET', `${base}/board/${boardId}/sprint`)).json()).values as any[]).find((x) => x.id === done2.summary.createdSprint.id);
    expect(made.state).toBe('future');
    expect(Date.parse(made.endDate) - Date.parse(made.startDate)).toBe(7 * day);
    // switching it off restores the old behaviour
    await admin('PUT', auto, { autoCreateNext: false, durationDays: 7, autoMoveIncomplete: 'backlog' });
  });
});
