import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, inArray } from 'drizzle-orm';
import app from '../../src/app';

/** Bulk issue operations: server-side, per-issue permission checks, partial success, preview and undo information. */
describe('Bulk issue operations API', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin: string, alice: string;
  let aliceId: number, adminId: number;
  let secId: number, hidId: number; // SEC: alice may only browse; HID: alice may not even browse
  let highPriority: { id: number };
  let doneStatusId: number, startTransitionId: number, resolveTransitionId: number;
  let versionId: number, componentId: number, sprintId: number, foreignSprintId: number;

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bulk = async (cookie: string, body: unknown, preview = false) => {
    const res = await call(cookie, 'POST', `/rest/api/2/bulk/issues${preview ? '?preview=true' : ''}`, body);
    return { status: res.status, body: (await res.json()) as any };
  };
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const mk = async (projectId: number, summary: string): Promise<string> => {
    const res = await call(admin, 'POST', '/rest/api/2/issue', { fields: { project: { id: projectId }, issuetype: { id: seeded.issueType.id }, summary } });
    expect(res.status).toBe(201);
    return (await res.json()).key;
  };
  const get = async (key: string) => (await (await call(admin, 'GET', `/rest/api/2/issue/${key}`)).json()) as any;
  const history = async (key: string) => {
    const [i] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, key));
    return db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, i.id));
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    adminId = seeded.user.id;
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, adminId));
    const [a] = await db.insert(schema.users).values({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash }).returning();
    aliceId = a.id;

    // TEST: alice may browse, edit and transition (no delete, no sprint management, no create)
    await db.insert(schema.permissionEntries).values(['BROWSE_PROJECTS', 'EDIT_ISSUES', 'TRANSITION_ISSUES'].map((p) => ({ schemeId: seeded.permScheme.id, permissionKey: p, userId: aliceId })));

    const [wfAssoc] = await db.select().from(schema.workflowSchemeAssociations).limit(1);
    const mkProject = async (key: string, perms: string[]) => {
      const [p] = await db.insert(schema.projects).values({ projectKey: key, name: key, leadId: adminId }).returning();
      const [s] = await db.insert(schema.permissionSchemes).values({ name: `${key} scheme` }).returning();
      await db.insert(schema.permissionSchemeAssociations).values({ projectId: p.id, schemeId: s.id });
      if (perms.length) await db.insert(schema.permissionEntries).values(perms.map((x) => ({ schemeId: s.id, permissionKey: x, userId: aliceId })));
      await db.insert(schema.workflowSchemeAssociations).values({ projectId: p.id, schemeId: wfAssoc.schemeId });
      return p.id;
    };
    secId = await mkProject('SEC', ['BROWSE_PROJECTS']);
    hidId = await mkProject('HID', []);

    [highPriority] = await db.insert(schema.priorities).values({ name: 'High', color: '#ff0000' }).returning();
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#16A06A' }).returning();
    doneStatusId = done.id;
    await db.insert(schema.resolutions).values({ name: 'Fixed' });
    const [start] = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, seeded.workflow.id));
    startTransitionId = start.id;
    const [resolve] = await db.insert(schema.workflowTransitions).values({
      workflowId: seeded.workflow.id, name: 'Resolve', fromStatusId: seeded.status2.id, toStatusId: doneStatusId,
      conditions: [{ type: 'always_true' }], validators: [{ type: 'field_required', field: 'comment' }], postFunctions: [],
    }).returning();
    resolveTransitionId = resolve.id;

    const [v] = await db.insert(schema.versions).values({ projectId: seeded.project.id, name: '1.0' }).returning();
    versionId = v.id;
    const [comp] = await db.insert(schema.components).values({ projectId: seeded.project.id, name: 'Backend' }).returning();
    componentId = comp.id;
    const [board] = await db.insert(schema.boards).values({ name: 'TEST board', type: 'scrum', projectId: seeded.project.id }).returning();
    const [sp] = await db.insert(schema.sprints).values({ name: 'Sprint 1', boardId: board.id, state: 'future' }).returning();
    sprintId = sp.id;
    const [board2] = await db.insert(schema.boards).values({ name: 'SEC board', type: 'scrum', projectId: secId }).returning();
    const [sp2] = await db.insert(schema.sprints).values({ name: 'Foreign sprint', boardId: board2.id, state: 'future' }).returning();
    foreignSprintId = sp2.id;

    admin = await login('admin');
    alice = await login('alice');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('validation: auth, operation, keys and params', async () => {
    expect((await app.request('/rest/api/2/bulk/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await bulk(admin, { issueKeys: ['TEST-1'], operation: 'explode', params: {} })).status).toBe(400);
    expect((await bulk(admin, { issueKeys: [], operation: 'watch' })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => `TEST-${i + 1}`);
    expect((await bulk(admin, { issueKeys: tooMany, operation: 'watch' })).status).toBe(400);
    expect((await bulk(admin, { issueKeys: ['TEST-1'], operation: 'assign', params: {} })).status).toBe(400);
    expect((await bulk(admin, { issueKeys: ['TEST-1'], operation: 'label', params: { add: ['a b'] } })).status).toBe(400);
    expect((await bulk(admin, { issueKeys: ['TEST-1'], operation: 'edit', params: { fields: { summary: 'x' } } })).status).toBe(400);
  });

  test('500 keys are accepted; unknown keys fail individually without aborting', async () => {
    const real = await mk(seeded.project.id, 'real one');
    const keys = [real, ...Array.from({ length: 499 }, (_, i) => `NOPE-${i + 1}`)];
    const r = await bulk(admin, { issueKeys: keys, operation: 'watch' });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toEqual([real]);
    expect(r.body.failed).toHaveLength(499);
    expect(r.body.failed[0].reason).toContain('does not exist');
  });

  test('assign + undo (grouped previous values), history is written like a single edit', async () => {
    const [k1, k2, k3] = [await mk(seeded.project.id, 'a1'), await mk(seeded.project.id, 'a2'), await mk(seeded.project.id, 'a3')];
    await call(admin, 'PUT', `/rest/api/2/issue/${k3}`, { fields: { assignee: { id: adminId } } });
    const r = await bulk(admin, { issueKeys: [k1, k2, k3], operation: 'assign', params: { assigneeId: aliceId } });
    expect(r.body.succeeded).toEqual([k1, k2, k3]);
    expect(r.body.failed).toEqual([]);
    expect((await get(k1)).fields.assignee.id).toBe(aliceId);
    expect((await history(k1)).some((h) => h.fieldName === 'assignee' && h.authorId === adminId)).toBe(true);
    // two groups: previously unassigned (k1, k2) and previously admin (k3)
    expect(r.body.undo).toHaveLength(2);
    for (const g of r.body.undo) {
      const u = await bulk(admin, { issueKeys: g.issueKeys, operation: g.operation, params: g.params });
      expect(u.body.failed).toEqual([]);
    }
    expect((await get(k1)).fields.assignee).toBeNull();
    expect((await get(k3)).fields.assignee.id).toBe(adminId);
    // unassign
    const un = await bulk(admin, { issueKeys: [k3], operation: 'assign', params: { assigneeId: null } });
    expect(un.body.succeeded).toEqual([k3]);
    expect((await get(k3)).fields.assignee).toBeNull();
  });

  test('priority + undo', async () => {
    const k = await mk(seeded.project.id, 'prio');
    await call(admin, 'PUT', `/rest/api/2/issue/${k}`, { fields: { priority: { id: seeded.priority.id } } });
    const r = await bulk(admin, { issueKeys: [k], operation: 'priority', params: { priorityId: highPriority.id } });
    expect(r.body.succeeded).toEqual([k]);
    expect((await get(k)).fields.priority.id).toBe(highPriority.id);
    const g = r.body.undo[0];
    await bulk(admin, { issueKeys: g.issueKeys, operation: g.operation, params: g.params });
    expect((await get(k)).fields.priority.id).toBe(seeded.priority.id);
  });

  test('labels: add / remove / set, no-ops succeed, undo restores previous sets', async () => {
    const k1 = await mk(seeded.project.id, 'l1');
    const k2 = await mk(seeded.project.id, 'l2');
    await bulk(admin, { issueKeys: [k1], operation: 'label', params: { add: ['old'] } });
    let r = await bulk(admin, { issueKeys: [k1, k2], operation: 'label', params: { add: ['urgent', 'old'] } });
    expect(r.body.failed).toEqual([]);
    expect((await get(k1)).fields.labels.sort()).toEqual(['old', 'urgent']);
    expect((await get(k2)).fields.labels.sort()).toEqual(['old', 'urgent']);
    const undo = r.body.undo;
    r = await bulk(admin, { issueKeys: [k1, k2], operation: 'label', params: { remove: ['old'] } });
    expect((await get(k2)).fields.labels).toEqual(['urgent']);
    // adding what is already there is a successful no-op without undo information
    r = await bulk(admin, { issueKeys: [k1], operation: 'label', params: { add: ['urgent'] } });
    expect(r.body.succeeded).toEqual([k1]);
    expect(r.body.undo).toBeUndefined();
    r = await bulk(admin, { issueKeys: [k2], operation: 'label', params: { set: ['x1', 'x2'] } });
    expect((await get(k2)).fields.labels.sort()).toEqual(['x1', 'x2']);
    for (const g of r.body.undo) await bulk(admin, { issueKeys: g.issueKeys, operation: g.operation, params: g.params });
    expect((await get(k2)).fields.labels).toEqual(['urgent']);
    expect(undo.length).toBeGreaterThan(0);
  });

  test('edit (duedate, storyPoints) + undo; fixVersion and component add/remove', async () => {
    const k = await mk(seeded.project.id, 'edit me');
    let r = await bulk(admin, { issueKeys: [k], operation: 'edit', params: { fields: { duedate: '2030-01-15', storyPoints: 5 } } });
    expect(r.body.succeeded).toEqual([k]);
    let f = (await get(k)).fields;
    expect(f.duedate).toBe('2030-01-15');
    expect(f.storyPoints).toBe(5);
    const g = r.body.undo[0];
    expect(g.operation).toBe('edit');
    await bulk(admin, { issueKeys: g.issueKeys, operation: g.operation, params: g.params });
    f = (await get(k)).fields;
    expect(f.duedate).toBeNull();
    expect(f.storyPoints).toBeNull();

    r = await bulk(admin, { issueKeys: [k], operation: 'fixVersion', params: { add: [versionId] } });
    expect(r.body.succeeded).toEqual([k]);
    expect((await get(k)).fields.fixVersions.map((v: any) => v.id)).toEqual([versionId]);
    await bulk(admin, { issueKeys: [k], operation: 'fixVersion', params: { remove: [versionId] } });
    expect((await get(k)).fields.fixVersions).toEqual([]);
    r = await bulk(admin, { issueKeys: [k], operation: 'component', params: { add: [componentId] } });
    expect((await get(k)).fields.components.map((v: any) => v.id)).toEqual([componentId]);
    const cu = r.body.undo[0];
    await bulk(admin, { issueKeys: cu.issueKeys, operation: cu.operation, params: cu.params });
    expect((await get(k)).fields.components).toEqual([]);
  });

  test('transition: partial success, workflow validator failure and per-issue reasons', async () => {
    const todo = await mk(seeded.project.id, 'todo');
    const started = await mk(seeded.project.id, 'started');
    await call(admin, 'POST', `/rest/api/2/issue/${started}/transitions`, { transition: { id: startTransitionId } });

    // Start Progress is available for the To Do issue only
    let r = await bulk(admin, { issueKeys: [todo, started], operation: 'transition', params: { transitionId: startTransitionId } });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toEqual([todo]);
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].key).toBe(started);
    expect(r.body.undo).toBeUndefined();
    expect((await get(todo)).fields.status.name).toBe('In Progress');

    // the Resolve validator (comment required) runs per issue
    r = await bulk(admin, { issueKeys: [todo, started], operation: 'transition', params: { transitionId: resolveTransitionId } });
    expect(r.body.succeeded).toEqual([]);
    expect(r.body.failed).toHaveLength(2);
    expect(r.body.failed[0].reason.toLowerCase()).toContain('comment');
    r = await bulk(admin, { issueKeys: [todo, started], operation: 'transition', params: { transitionId: resolveTransitionId, comment: 'Done in bulk' } });
    expect(r.body.failed).toEqual([]);
    expect((await get(started)).fields.status.name).toBe('Done');
    // the history of each issue records the status change like a single transition
    expect((await history(started)).some((h) => h.fieldName === 'status')).toBe(true);
  });

  test('available transitions: intersection of the selected issues', async () => {
    const a = await mk(seeded.project.id, 'common a');
    const b = await mk(seeded.project.id, 'common b');
    await call(admin, 'POST', `/rest/api/2/issue/${b}/transitions`, { transition: { id: startTransitionId } });
    const res = await call(admin, 'POST', '/rest/api/2/bulk/issues/transitions', { issueKeys: [a, b] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.commonIds).toEqual([]);
    const start = body.transitions.find((t: any) => t.id === startTransitionId);
    expect(start).toMatchObject({ count: 1, issueKeys: [a] });
    const resolve = body.transitions.find((t: any) => t.id === resolveTransitionId);
    expect(resolve).toMatchObject({ count: 1, issueKeys: [b] });
    const both = await (await call(admin, 'POST', '/rest/api/2/bulk/issues/transitions', { issueKeys: [a] })).json();
    expect(both.commonIds).toContain(startTransitionId);
  });

  test('watch and unwatch act for the caller', async () => {
    const [k1, k2] = [await mk(seeded.project.id, 'w1'), await mk(seeded.project.id, 'w2')];
    let r = await bulk(alice, { issueKeys: [k1, k2], operation: 'watch' });
    expect(r.body.succeeded).toEqual([k1, k2]);
    const rows = async () => db.select().from(schema.watchers).where(eq(schema.watchers.userId, aliceId));
    expect((await rows()).length).toBeGreaterThanOrEqual(2);
    r = await bulk(alice, { issueKeys: [k1, k2], operation: 'unwatch' });
    expect(r.body.succeeded).toEqual([k1, k2]);
    expect(await rows()).toHaveLength(0);
  });

  test('sprint: move into a sprint, wrong-project sprint fails per issue, back to the backlog', async () => {
    const [k1, k2] = [await mk(seeded.project.id, 's1'), await mk(seeded.project.id, 's2')];
    let r = await bulk(admin, { issueKeys: [k1, k2], operation: 'sprint', params: { sprintId } });
    expect(r.body.succeeded).toEqual([k1, k2]);
    const inSprint = async () => (await db.select().from(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, sprintId))).length;
    expect(await inSprint()).toBeGreaterThanOrEqual(2);
    r = await bulk(admin, { issueKeys: [k1], operation: 'sprint', params: { sprintId: foreignSprintId } });
    expect(r.body.succeeded).toEqual([]);
    expect(r.body.failed[0].reason).toContain('different project');
    r = await bulk(admin, { issueKeys: [k1, k2], operation: 'sprint', params: { sprintId: null } });
    expect(r.body.succeeded).toEqual([k1, k2]);
    expect(await inSprint()).toBe(0);
  });

  test('move to another project', async () => {
    const k = await mk(seeded.project.id, 'move me');
    const r = await bulk(admin, { issueKeys: [k], operation: 'move', params: { projectId: secId } });
    expect(r.body.succeeded).toEqual([k]);
    expect((await get(k)).fields).toBeUndefined(); // the old key is gone ...
    const [moved] = await db.select().from(schema.issues).where(eq(schema.issues.summary, 'move me'));
    expect(moved.projectId).toBe(secId); // ... the issue lives in SEC now
    expect(moved.issueKey.startsWith('SEC-')).toBe(true);
    const bad = await bulk(admin, { issueKeys: [moved.issueKey], operation: 'move', params: { projectId: 987654 } });
    expect(bad.body.failed[0].reason).toContain('not found');
  });

  test('permissions are checked per issue: partial success across projects', async () => {
    const own = await mk(seeded.project.id, 'own project');
    const sec = await mk(secId, 'browse only');
    const hid = await mk(hidId, 'hidden');
    const r = await bulk(alice, { issueKeys: [own, sec, hid, 'NOPE-1'], operation: 'priority', params: { priorityId: highPriority.id } });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toEqual([own]);
    const reason = (k: string) => r.body.failed.find((f: any) => f.key === k)?.reason;
    expect(reason(sec)).toBe('Forbidden');
    // hidden and non-existent issues are indistinguishable
    expect(reason(hid)).toBe(reason('NOPE-1'));
    expect(reason(hid)).toContain('does not exist');
    expect((await get(own)).fields.priority.id).toBe(highPriority.id);
    expect((await get(sec)).fields.priority?.id).not.toBe(highPriority.id);
  });

  test('delete needs DELETE_ISSUES per issue; undo information is never returned', async () => {
    const [k1, k2] = [await mk(seeded.project.id, 'd1'), await mk(seeded.project.id, 'd2')];
    let r = await bulk(alice, { issueKeys: [k1, k2], operation: 'delete' });
    expect(r.body.succeeded).toEqual([]);
    expect(r.body.failed.map((f: any) => f.reason)).toEqual(['Forbidden', 'Forbidden']);
    expect((await call(admin, 'GET', `/rest/api/2/issue/${k1}`)).status).toBe(200);
    r = await bulk(admin, { issueKeys: [k1, k2], operation: 'delete' });
    expect(r.body.succeeded).toEqual([k1, k2]);
    expect(r.body.undo).toBeUndefined();
    expect((await call(admin, 'GET', `/rest/api/2/issue/${k1}`)).status).toBe(404);
  });

  test('preview changes nothing and reports what would fail', async () => {
    const own = await mk(seeded.project.id, 'pv own');
    const started = await mk(seeded.project.id, 'pv started');
    await call(admin, 'POST', `/rest/api/2/issue/${started}/transitions`, { transition: { id: startTransitionId } });
    const sec = await mk(secId, 'pv sec');

    let r = await bulk(alice, { issueKeys: [own, sec], operation: 'edit', params: { fields: { environment: 'x' } } }, true);
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(true);
    expect(r.body.succeeded).toEqual([own]);
    expect(r.body.failed).toEqual([{ key: sec, reason: expect.stringContaining('Forbidden') }]);
    expect(r.body.failureGroups).toEqual([{ reason: expect.any(String), count: 1, keys: [sec] }]);
    expect((await get(own)).fields.environment).toBeNull();

    r = await bulk(admin, { issueKeys: [own, started], operation: 'transition', params: { transitionId: startTransitionId } }, true);
    expect(r.body.succeeded).toEqual([own]);
    expect(r.body.failed[0]).toMatchObject({ key: started });
    expect(r.body.failed[0].reason).toContain('not available');
    expect((await get(own)).fields.status.name).toBe('To Do');

    r = await bulk(admin, { issueKeys: [started], operation: 'transition', params: { transitionId: resolveTransitionId } }, true);
    expect(r.body.failed[0].reason).toContain('comment');
    r = await bulk(admin, { issueKeys: [started], operation: 'transition', params: { transitionId: resolveTransitionId, comment: 'ok' } }, true);
    expect(r.body.failed).toEqual([]);

    r = await bulk(admin, { issueKeys: [own], operation: 'sprint', params: { sprintId: foreignSprintId } }, true);
    expect(r.body.failed[0].reason).toContain('different project');
    r = await bulk(alice, { issueKeys: [own], operation: 'delete' }, true);
    expect(r.body.failed[0].reason).toContain('Forbidden');
    expect((await db.select().from(schema.issues).where(inArray(schema.issues.issueKey, [own]))).length).toBe(1);
  });

  test('a bulk run larger than the per-minute rate limit is not throttled per issue', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) keys.push(await mk(seeded.project.id, `bulk ${i}`));
    const r = await bulk(admin, { issueKeys: keys, operation: 'label', params: { add: ['batch'] } });
    expect(r.body.succeeded).toHaveLength(30);
    expect(r.body.failed).toEqual([]);
  });
});
