import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

const DAY = 86_400_000;

describe('Burnup, release burndown, version report, flagged issues, card colours', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let cookie: string;
  let boardId: number;
  let sprintId: number;
  let versionId: number;
  let releasedId: number;
  let epicKey: string;
  let keys: Record<string, string> = {};
  const startOfToday = Math.floor(Date.now() / DAY) * DAY;
  const start = startOfToday - 4 * DAY; // sprint day 0 (UTC midnight); "today" is day 4
  const at = (day: number, hour: number) => new Date(start + day * DAY + hour * 3_600_000);
  const iso = (day: number) => new Date(start + day * DAY).toISOString().slice(0, 10);

  const get = (path: string) => app.request(path, { headers: { Cookie: cookie } });
  const put = (path: string, body: unknown) => app.request(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  const R = () => `/rest/agile/1.0/board/${boardId}/report`;

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
    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id }).returning();
    boardId = board.id;
    const [sprint] = await db.insert(schema.sprints).values({
      name: 'Sprint X', state: 'active', boardId, startDate: at(0, 0), endDate: at(8, 0),
    }).returning();
    sprintId = sprint.id;
    const [v1] = await db.insert(schema.versions).values({
      projectId: seeded.project.id, name: 'v1.0', startDate: iso(0), releaseDate: iso(10), released: false,
    }).returning();
    versionId = v1.id;
    const [v2] = await db.insert(schema.versions).values({
      projectId: seeded.project.id, name: 'v0.9', startDate: iso(-20), releaseDate: iso(-5), released: true,
    }).returning();
    releasedId = v2.id;

    const mk = async (name: string, points: number, statusId: number, created: Date) => {
      const [i] = await db.insert(schema.issues).values({
        issueKey: `TEST-${name}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId,
        summary: `Issue ${name}`, reporterId: seeded.user.id, storyPoints: points.toFixed(2), createdAt: created,
      }).returning();
      keys[name] = i.issueKey;
      return i;
    };
    const hist = (issueId: number, fieldName: string, oldValue: string | null, newValue: string | null, when: Date) =>
      db.insert(schema.issueHistory).values({ issueId, fieldName, oldValue, newValue, createdAt: when });

    // A (2): committed, done on day 1.  B (3): committed, done day 2, reopened day 3.
    // C (5): added to the sprint on day 2.  D (1): committed, removed from the sprint on day 3.
    const A = await mk('A', 2, done.id, at(-3, 0));
    const B = await mk('B', 3, seeded.status2.id, at(-3, 0));
    const C = await mk('C', 5, seeded.status.id, at(-3, 0));
    const D = await mk('D', 1, seeded.status.id, at(-3, 0));
    await db.insert(schema.sprintIssues).values([
      { sprintId, issueId: A.id, addedAt: at(-1, 0) }, { sprintId, issueId: B.id, addedAt: at(-1, 0) },
      { sprintId, issueId: C.id, addedAt: at(2, 8) },
    ]);
    await hist(C.id, 'Sprint', null, 'Sprint X', at(2, 8));
    await hist(D.id, 'Sprint', 'Sprint X', null, at(3, 6));
    await hist(A.id, 'status', 'To Do', 'Done', at(1, 12));
    await hist(B.id, 'status', 'To Do', 'Done', at(2, 12));
    await hist(B.id, 'status', 'Done', 'In Progress', at(3, 12));

    // Version v1.0: A (2, done day 1), B (3, reopened), E (4) added day 2, F (6) removed day 3. v0.9: G (3, done).
    const E = await mk('E', 4, seeded.status.id, at(-3, 0));
    const F = await mk('F', 6, seeded.status.id, at(-3, 0));
    const G = await mk('G', 3, done.id, at(-30, 0));
    await db.insert(schema.issueFixVersions).values([
      { issueId: A.id, versionId }, { issueId: B.id, versionId }, { issueId: E.id, versionId }, { issueId: G.id, versionId: releasedId },
    ]);
    await hist(E.id, 'fixVersions', '', String(versionId), at(2, 9));
    await hist(F.id, 'fixVersions', String(versionId), '', at(3, 9));
    await hist(G.id, 'status', 'To Do', 'Done', at(-10, 0));
    await db.insert(schema.issueFixVersions).values({ issueId: A.id, versionId: releasedId });

    // Epic with children A and E (parent links)
    const [epicType] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    const [epic] = await db.insert(schema.issues).values({
      issueKey: 'TEST-EPIC', projectId: seeded.project.id, issueTypeId: epicType.id, statusId: seeded.status.id,
      summary: 'Epic', reporterId: seeded.user.id, createdAt: at(-3, 0),
    }).returning();
    epicKey = epic.issueKey;
    await db.update(schema.issues).set({ parentId: epic.id }).where(eq(schema.issues.id, A.id));
    await db.update(schema.issues).set({ parentId: epic.id }).where(eq(schema.issues.id, E.id));
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('sprint burnup has exact scope and completed series and lists the scope changes', async () => {
    const res = await get(`${R()}/burnup?scope=sprint&sprintId=${sprintId}&unit=points&nocache=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const p = body.points as Array<{ date: string; scope: number | null; completed: number | null }>;
    expect(p).toHaveLength(9);
    expect(p.slice(0, 5).map((x) => [x.date, x.scope, x.completed])).toEqual([
      [iso(0), 6, 0],   // A2 + B3 + D1
      [iso(1), 6, 2],   // A done
      [iso(2), 11, 5],  // C (5) added, B done
      [iso(3), 10, 2],  // D removed, B reopened
      [iso(4), 10, 2],
    ]);
    expect(p[5].scope).toBeNull(); // future days
    expect(body.initialScope).toBe(6);
    expect(body.scopeChanges.map((c: any) => [c.kind, c.key, c.size])).toEqual([['added', keys.C, 5], ['removed', keys.D, 1]]);
  });

  test('burnup switches to issue count', async () => {
    const body = await (await get(`${R()}/burnup?scope=sprint&sprintId=${sprintId}&unit=issues&nocache=1`)).json();
    expect(body.points.slice(0, 5).map((x: any) => [x.scope, x.completed])).toEqual([[3, 0], [3, 1], [4, 2], [3, 1], [3, 1]]);
  });

  test('sprint report now lists the scope added and removed after the start', async () => {
    const body = await (await get(`${R()}/sprint?sprintId=${sprintId}&unit=points`)).json();
    expect(body.scopeChanges.map((c: any) => c.kind)).toEqual(['added', 'removed']);
  });

  test('version burnup follows fixVersions history', async () => {
    const body = await (await get(`${R()}/burnup?scope=version&versionId=${versionId}&unit=points&nocache=1`)).json();
    const p = body.points;
    expect(p[0]).toMatchObject({ date: iso(0), scope: 11, completed: 0 }); // A2 + B3 + F6 (E not yet)
    expect(p[1]).toMatchObject({ scope: 11, completed: 2 });
    expect(p[2]).toMatchObject({ scope: 15, completed: 5 }); // E (4) joins on day 2
    expect(p[3]).toMatchObject({ scope: 9, completed: 2 }); // F removed, B reopened
    expect(p[4]).toMatchObject({ date: iso(4), scope: 9, completed: 2 });
    expect(body.scopeChanges.map((c: any) => [c.kind, c.key])).toEqual([['added', keys.E], ['removed', keys.F]]);
  });

  test('epic burnup uses the parent history/current children', async () => {
    const body = await (await get(`${R()}/burnup?scope=epic&epicKey=${epicKey}&unit=points&nocache=1`)).json();
    expect(body.scope).toBe(6); // A 2 + E 4
    expect(body.completed).toBe(2);
  });

  test('release burndown: remaining, velocity, projection', async () => {
    const body = await (await get(`${R()}/release-burndown?versionId=${versionId}&unit=points&lookback=4&nocache=1`)).json();
    expect(body).toMatchObject({ scope: 9, completed: 2, remaining: 7, velocityPerDay: 0.5, releaseDate: iso(10), onTrack: false });
    expect(body.projectedDate).toBe(iso(4 + 14));
    expect(body.daysLate).toBe(8);
    const byDate = Object.fromEntries(body.points.map((x: any) => [x.date, x]));
    expect(byDate[iso(0)]).toMatchObject({ remaining: 11, ideal: 11 });
    expect(byDate[iso(2)].remaining).toBe(10);
    expect(byDate[iso(4)].projected).toBe(7);
    expect(byDate[iso(10)].ideal).toBe(0);
  });

  test('epic burndown works with the same engine', async () => {
    const res = await get(`${R()}/epic-burndown?epicKey=${epicKey}&unit=points&nocache=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scope: 6, completed: 2, remaining: 4 });
  });

  test('version report for an unreleased version', async () => {
    const body = await (await get(`${R()}/version?versionId=${versionId}&unit=points&nocache=1`)).json();
    expect(body).toMatchObject({ issues: { done: 1, todo: 1, inProgress: 1, total: 3 }, completed: 2, remaining: 7, total: 9 });
    expect(body.groups.map((g: any) => g.status)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(body.projection).toMatchObject({ onTrack: false });
    expect(body.version.released).toBe(false);
  });

  test('version report for a released version has no projection', async () => {
    const body = await (await get(`${R()}/version?versionId=${releasedId}&unit=points&nocache=1`)).json();
    expect(body.version.released).toBe(true);
    expect(body.projection).toBeNull();
    expect(body).toMatchObject({ issues: { done: 2, total: 2 }, completed: 5, remaining: 0 });
  });

  test('version list, auth and unknown ids', async () => {
    const list = await (await get(`${R()}/versions`)).json();
    expect(list.versions.map((v: any) => v.name).sort()).toEqual(['v0.9', 'v1.0']);
    expect((await app.request(`${R()}/version?versionId=${versionId}`)).status).toBe(401);
    expect((await get(`${R()}/version?versionId=99999`)).status).toBe(404);
    expect((await get(`${R()}/burnup?scope=nope`)).status).toBe(400);
    expect((await get(`/rest/agile/1.0/board/99999/report/burnup?scope=version&versionId=${versionId}`)).status).toBe(404);
  });

  test('flag and unflag an issue: history, response, JQL, sprint report', async () => {
    let res = await put(`/rest/api/2/issue/${keys.B}`, { fields: { flagged: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).fields.flagged).toBe(true);
    const hist = await (await get(`/rest/api/2/issue/${keys.B}/changelog`)).json();
    const flagged = hist.histories.find((h: any) => h.items[0].field === 'flagged');
    expect(flagged.items[0]).toMatchObject({ from: null, to: 'Impediment' });

    // setting it again is a no-op in the history
    await put(`/rest/api/2/issue/${keys.B}`, { fields: { flagged: true } });
    const hist2 = await (await get(`/rest/api/2/issue/${keys.B}/changelog`)).json();
    expect(hist2.histories.filter((h: any) => h.items[0].field === 'flagged')).toHaveLength(1);

    const search = async (jql: string) => (await (await get(`/rest/api/2/search?jql=${encodeURIComponent(jql)}`)).json()).issues.map((i: any) => i.key);
    expect(await search('flagged = true')).toEqual([keys.B]);
    expect(await search('flagged is not EMPTY')).toEqual([keys.B]);
    expect(await search('flagged = Impediment')).toEqual([keys.B]);
    expect(await search('flagged is EMPTY AND key = ' + keys.A)).toEqual([keys.A]);
    expect(await search('flagged = false AND key = ' + keys.B)).toEqual([]);
    expect(await search('flagged != true AND key = ' + keys.B)).toEqual([]);

    const sprint = await (await get(`${R()}/sprint?sprintId=${sprintId}&unit=points`)).json();
    expect(sprint.flaggedIssues).toEqual([keys.B]);
    const vr = await (await get(`${R()}/version?versionId=${versionId}&unit=points&nocache=1`)).json();
    expect(vr.flagged).toBe(1);

    res = await put(`/rest/api/2/issue/${keys.B}`, { fields: { flagged: false } });
    expect((await res.json()).fields.flagged).toBe(false);
    expect(await search('flagged = true')).toEqual([]);
    expect((await put(`/rest/api/2/issue/${keys.B}`, { fields: { flagged: 'yes' } })).status).toBe(400);
  });

  test('board config validation and card colour rules', async () => {
    const bad = await put(`/rest/api/2/board/${boardId}`, { config: { cardColour: { by: 'rules', rules: [{ jql: 'priority = High', colour: '#fff' }] } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errorMessages[0]).toContain('colour must be one of');
    expect((await put(`/rest/api/2/board/${boardId}`, { config: { cardColour: { by: 'weather' } } })).status).toBe(400);
    expect((await put(`/rest/api/2/board/${boardId}`, { config: { cardColour: { by: 'rules', rules: [{ jql: 'flagged = = x', colour: 'red' }] } } })).status).toBe(400);

    await put(`/rest/api/2/issue/${keys.A}`, { fields: { flagged: true } });
    const ok = await put(`/rest/api/2/board/${boardId}`, {
      config: { swimlaneField: 'assignee', cardColour: { by: 'rules', rules: [
        { name: 'Blocked', jql: 'flagged = true', colour: 'red' },
        { name: 'Everything else', jql: 'project = TEST', colour: 'blue' },
      ] } },
    });
    expect(ok.status).toBe(200);
    const board = await (await get(`/rest/api/2/board/${boardId}?nocache=1`)).json();
    expect(board.config.swimlaneField).toBe('assignee');
    expect(board.config.cardColour.rules).toHaveLength(2);

    const res = await app.request(`/rest/agile/1.0/board/${boardId}/card-colours`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ keys: [keys.A, keys.B, 'NOPE-1'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ by: 'rules', colours: { [keys.A]: 0, [keys.B]: 1 } }); // first matching rule wins
    expect((await app.request(`/rest/agile/1.0/board/${boardId}/card-colours`, { method: 'POST', body: '{}' })).status).toBe(401);
    await put(`/rest/api/2/issue/${keys.A}`, { fields: { flagged: false } });
  });
});
