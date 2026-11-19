import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { redis } from '../../src/services/cache';
import app from '../../src/app';

describe('Workflow designer API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin: string, bob: string;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  let issueId: number;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const call = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.request(url, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const A = '/rest/api/2/admin';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    const [issue] = await db.insert(schema.issues).values({
      issueKey: 'TEST-1', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status2.id,
      summary: 'one', reporterId: seeded.user.id,
    }).returning();
    issueId = issue.id;
    // earlier suites share user ids and exhaust the per-user rate limit window
    for (let uid = 1; uid <= 5; uid++) await redis.del(`veqsio:ratelimit:user:${uid}`);
    admin = await login('admin');
    bob = await login('bob');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('requires SYSTEM_ADMIN and a session', async () => {
    expect((await app.request(`${A}/workflow`)).status).toBe(401);
    expect((await call(bob, 'GET', `${A}/workflow`)).status).toBe(403);
    expect((await call(bob, 'POST', `${A}/workflow`, { name: 'x' })).status).toBe(403);
    expect((await call(bob, 'GET', `${A}/status`)).status).toBe(403);
    expect((await call(bob, 'DELETE', `${A}/workflow/${seeded.workflow.id}`)).status).toBe(403);
  });

  test('lists workflows with transition counts and users', async () => {
    const res = await call(admin, 'GET', `${A}/workflow`);
    expect(res.status).toBe(200);
    const { workflows } = await res.json();
    const def = workflows.find((w: any) => w.id === seeded.workflow.id);
    expect(def).toMatchObject({ name: 'Default Workflow', isDefault: true, transitionCount: 1 });
    expect(def.schemes).toEqual([{ id: expect.any(Number), name: 'Default Scheme' }]);
    expect(def.projects.map((p: any) => p.key)).toEqual(['TEST']);
  });

  test('exposes the supported types with parameter schemas', async () => {
    const body = await (await call(admin, 'GET', `${A}/workflow/types`)).json();
    expect(body.conditions.map((t: any) => t.type)).toContain('user_in_group');
    expect(body.validators.map((t: any) => t.type)).not.toContain('custom_script');
    expect(body.postFunctions.find((t: any) => t.type === 'set_resolution').params[0]).toMatchObject({ name: 'resolution_id', type: 'resolution', required: true });
    expect(body.lookups).toHaveProperty('group');
    expect(body.categories).toEqual(['backlog', 'to_do', 'in_progress', 'done', 'cancelled']);
  });

  test('validation errors use the errorMessages shape', async () => {
    const res = await call(admin, 'POST', `${A}/workflow`, { name: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages.length).toBeGreaterThan(0);
    // a non-numeric id cannot exist: the global id guard answers 404 (see middleware/request-guards.ts)
    expect((await call(admin, 'GET', `${A}/workflow/abc`)).status).toBe(404);
    const nf = await call(admin, 'GET', `${A}/workflow/99999`);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ errorMessages: ['Workflow not found'] });
  });

  let wfId: number;
  let doneId: number;

  test('creates, renames and rejects duplicate names', async () => {
    const res = await call(admin, 'POST', `${A}/workflow`, { name: 'Support flow', description: 'for desks' });
    expect(res.status).toBe(201);
    wfId = (await res.json()).id;
    expect((await call(admin, 'POST', `${A}/workflow`, { name: 'support FLOW' })).status).toBe(409);
    expect((await call(admin, 'PUT', `${A}/workflow/${wfId}`, { name: 'Support workflow' })).status).toBe(200);
    expect((await call(admin, 'PUT', `${A}/workflow/${wfId}`, { name: 'Default Workflow' })).status).toBe(409);
    const detail = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect(detail).toMatchObject({ name: 'Support workflow', description: 'for desks', transitions: [], statuses: [], isDefault: false });
  });

  test('statuses: create, update, validate, refuse delete when used', async () => {
    const bad = await call(admin, 'POST', `${A}/status`, { name: 'Done', category: 'finished' });
    expect(bad.status).toBe(400);
    const res = await call(admin, 'POST', `${A}/status`, { name: 'Done', category: 'done' });
    expect(res.status).toBe(201);
    const s = await res.json();
    doneId = s.id;
    expect(s).toMatchObject({ name: 'Done', category: 'done' });
    expect(s.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect((await call(admin, 'POST', `${A}/status`, { name: 'done', category: 'done' })).status).toBe(409);
    expect((await call(admin, 'PUT', `${A}/status/${doneId}`, { color: 'red' })).status).toBe(400);
    const upd = await call(admin, 'PUT', `${A}/status/${doneId}`, { name: 'Completed', color: '#112233' });
    expect(await upd.json()).toMatchObject({ name: 'Completed', color: '#112233' });

    const list = await (await call(admin, 'GET', `${A}/status`)).json();
    expect(list.statuses.find((x: any) => x.id === seeded.status2.id)).toMatchObject({ issueCount: 1, transitionCount: 1 });

    const used = await call(admin, 'DELETE', `${A}/status/${seeded.status2.id}`);
    expect(used.status).toBe(409);
    expect((await used.json()).errorMessages[0]).toContain('1 issue');
    const usedByTransition = await call(admin, 'DELETE', `${A}/status/${seeded.status.id}`);
    expect(usedByTransition.status).toBe(409);
    expect((await usedByTransition.json()).errorMessages[0]).toContain('transition');
  });

  test('transitions: add, update, global, duplicates and type validation', async () => {
    const mk = (p: any) => call(admin, 'POST', `${A}/workflow/${wfId}/transition`, p);
    const open = seeded.status.id, prog = seeded.status2.id;

    const r1 = await mk({ name: 'Start', fromStatusId: open, toStatusId: prog, conditions: [{ type: 'user_in_group', group_id: 1 }], postFunctions: [{ type: 'assign_to_user' }] });
    expect(r1.status).toBe(201);
    const t1 = (await r1.json()).id;

    expect((await mk({ name: 'Start', fromStatusId: open, toStatusId: prog })).status).toBe(400); // duplicate
    expect((await mk({ name: 'X', fromStatusId: open, toStatusId: 99999 })).status).toBe(400); // unknown status
    const unsupported = await mk({ name: 'Y', fromStatusId: open, toStatusId: prog, validators: [{ type: 'custom_script', script: 'x' }] });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).errorMessages[0]).toContain('unsupported type');
    expect((await mk({ name: 'Y', fromStatusId: open, toStatusId: prog, postFunctions: [{ type: 'set_resolution' }] })).status).toBe(400);
    expect((await mk({ name: 'Y', fromStatusId: open, toStatusId: prog, validators: [{ type: 'field_regex', field: 'a', pattern: '(' }] })).status).toBe(400);
    expect((await mk({ name: 'Y', fromStatusId: open, toStatusId: prog, screenId: 4242 })).status).toBe(400);

    const g = await mk({ name: 'Close', fromStatusId: null, toStatusId: doneId, postFunctions: [{ type: 'add_comment', body: 'closed' }] });
    expect(g.status).toBe(201);
    const globalId = (await g.json()).id;

    const upd = await call(admin, 'PUT', `${A}/workflow/${wfId}/transition/${t1}`, { name: 'Begin work', validators: [{ type: 'field_required', field: 'assignee' }] });
    expect(upd.status).toBe(200);

    const detail = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect(detail.transitions).toHaveLength(2);
    expect(detail.transitions.find((t: any) => t.id === t1)).toMatchObject({
      name: 'Begin work', fromStatusId: open, toStatusId: prog,
      validators: [{ type: 'field_required', field: 'assignee' }], conditions: [{ type: 'user_in_group', group_id: 1 }],
    });
    expect(detail.transitions.find((t: any) => t.id === globalId).fromStatusId).toBeNull();
    expect(detail.statuses.map((s: any) => s.id).sort()).toEqual([open, prog, doneId].sort());
    // Progress has no outgoing transition, but the global one covers it
    expect(detail.warnings.some((w: any) => w.code === 'dead_end')).toBe(false);

    // transition of another workflow cannot be touched through this one
    const other = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, seeded.workflow.id));
    expect((await call(admin, 'PUT', `${A}/workflow/${wfId}/transition/${other[0].id}`, { name: 'hijack' })).status).toBe(404);
    expect((await call(admin, 'DELETE', `${A}/workflow/${wfId}/transition/${other[0].id}`)).status).toBe(404);
  });

  test('designer layout is stored and keeps statuses without transitions', async () => {
    const bad = await call(admin, 'PUT', `${A}/workflow/${wfId}/layout`, { nodes: { '1': { x: 'a', y: 2 } } });
    expect(bad.status).toBe(400);
    expect((await call(admin, 'PUT', `${A}/workflow/${wfId}/layout`, { nodes: { '999999': { x: 1, y: 2 } } })).status).toBe(400);
    const [lone] = await db.insert(schema.statuses).values({ name: 'Lonely', category: 'to_do' }).returning();
    const ok = await call(admin, 'PUT', `${A}/workflow/${wfId}/layout`, { nodes: { [seeded.status.id]: { x: 10.4, y: 20 }, [lone.id]: { x: 300, y: 40 } } });
    expect(ok.status).toBe(200);
    const detail = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect(detail.positions[String(lone.id)]).toEqual({ x: 300, y: 40 });
    expect(detail.positions[String(seeded.status.id)]).toEqual({ x: 10, y: 20 });
    expect(detail.statuses.some((s: any) => s.id === lone.id)).toBe(true);
    expect(detail.warnings.some((w: any) => w.code === 'no_transitions' && w.statusId === lone.id)).toBe(true);

    // a status placed on a canvas cannot be deleted silently: it has no transitions, so deletion cleans the layout
    expect((await call(admin, 'DELETE', `${A}/status/${lone.id}`)).status).toBe(200);
    const after = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect(after.positions[String(lone.id)]).toBeUndefined();
  });

  test('clone copies transitions and layout independently', async () => {
    const res = await call(admin, 'POST', `${A}/workflow`, { name: 'Support copy', cloneFromId: wfId });
    expect(res.status).toBe(201);
    const cloneId = (await res.json()).id;
    const clone = await (await call(admin, 'GET', `${A}/workflow/${cloneId}`)).json();
    expect(clone.transitions.map((t: any) => t.name).sort()).toEqual(['Begin work', 'Close']);
    expect(clone.description).toBe('for desks');
    expect(clone.isDefault).toBe(false);
    await call(admin, 'DELETE', `${A}/workflow/${cloneId}/transition/${clone.transitions[0].id}`);
    const orig = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect(orig.transitions).toHaveLength(2);
    expect((await call(admin, 'POST', `${A}/workflow`, { name: 'Ghost', cloneFromId: 99999 })).status).toBe(404);
    expect((await call(admin, 'DELETE', `${A}/workflow/${cloneId}`)).status).toBe(200);
  });

  test('refuses deleting default or assigned workflows and says why', async () => {
    const def = await call(admin, 'DELETE', `${A}/workflow/${seeded.workflow.id}`);
    expect(def.status).toBe(409);
    expect((await def.json()).errorMessages[0]).toContain('default workflow');

    await db.insert(schema.workflowSchemeItems).values({ schemeId: (await db.select().from(schema.workflowSchemes))[0].id, issueTypeId: (await db.insert(schema.issueTypes).values({ name: 'Bug' }).returning())[0].id, workflowId: wfId });
    const used = await call(admin, 'DELETE', `${A}/workflow/${wfId}`);
    expect(used.status).toBe(409);
    expect((await used.json()).errorMessages[0]).toContain('Default Scheme');
    await db.delete(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.workflowId, wfId));
  });

  test('runtime still works: designer-made and global transitions execute', async () => {
    // put the Default workflow's issue through a transition created in the designer
    const tr = await call(admin, 'POST', `${A}/workflow/${seeded.workflow.id}/transition`, {
      name: 'Back to To Do', fromStatusId: seeded.status2.id, toStatusId: seeded.status.id,
    });
    expect(tr.status).toBe(201);
    const gl = await call(admin, 'POST', `${A}/workflow/${seeded.workflow.id}/transition`, { name: 'Complete', fromStatusId: null, toStatusId: doneId });

    const res = await call(admin, 'GET', '/rest/api/2/issue/TEST-1/transitions');
    expect(res.status).toBe(200);
    const names = (await res.json()).transitions.map((t: any) => t.name).sort();
    expect(names).toEqual(['Back to To Do', 'Complete']);

    const gid = (await gl.json()).id;
    const run = await call(admin, 'POST', '/rest/api/2/issue/TEST-1/transitions', { transition: { id: String(gid) } });
    expect(run.status).toBe(200);
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
    expect(issue.statusId).toBe(doneId);

    // done status is now in use
    expect((await call(admin, 'DELETE', `${A}/status/${doneId}`)).status).toBe(409);
    // existing public endpoint unchanged
    const wfs = await (await call(admin, 'GET', '/rest/api/2/workflow')).json();
    expect(wfs.values.length).toBeGreaterThanOrEqual(2);
  });

  test('deleting a transition and a workflow works', async () => {
    const d = await (await call(admin, 'GET', `${A}/workflow/${wfId}`)).json();
    expect((await call(admin, 'DELETE', `${A}/workflow/${wfId}/transition/${d.transitions[0].id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `${A}/workflow/${wfId}/transition/${d.transitions[0].id}`)).status).toBe(404);
    expect((await call(admin, 'DELETE', `${A}/workflow/${wfId}`)).status).toBe(200);
    expect((await call(admin, 'GET', `${A}/workflow/${wfId}`)).status).toBe(404);
  });
});
