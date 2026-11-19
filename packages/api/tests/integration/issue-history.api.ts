import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { invalidateInstanceSettings } from '../../src/settings/instance';

describe('Issue history depth: time in status, description versions, type switch, governance, JQL extras', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: any;
  let admin = '', viewer = '', editor = '', padmin = '';
  let bugType: any, subType: any, doneStatus: any, reviewStatus: any, bugWorkflow: any;
  const ids: Record<string, number> = {};

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => (await r.json()) as any;
  const create = async (summary: string, typeId = seeded.issueType.id, extra: Record<string, unknown> = {}) => {
    const r = await req('POST', '/rest/api/2/issue', admin, { fields: { project: { id: seeded.project.id }, issuetype: { id: typeId }, summary, ...extra } });
    expect(r.status).toBe(201);
    return (await json(r)).key as string;
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = async (username: string) => (await db.insert(schema.users).values({ username, email: `${username}@x.test`, displayName: username, passwordHash: hash }).returning())[0];
    const v = await mk('viewer'), e = await mk('editor'), pa = await mk('padmin');
    // TEST project: viewer browses; editor browses + edits + creates; padmin browses + administers
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, seeded.project.id));
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'History' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: seeded.project.id, schemeId: scheme.id });
    await db.insert(schema.permissionEntries).values([
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: v.id },
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: e.id },
      { schemeId: scheme.id, permissionKey: 'EDIT_ISSUES', userId: e.id },
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: pa.id },
      { schemeId: scheme.id, permissionKey: 'PROJECT_ADMIN', userId: pa.id },
    ]);
    // SEC project nobody but admin sees
    const [sec] = await db.insert(schema.projects).values({ projectKey: 'SEC', name: 'Secret', leadId: seeded.user.id }).returning();
    ids.sec = sec.id;
    const [s2] = await db.insert(schema.permissionSchemes).values({ name: 'SecretOnly' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: sec.id, schemeId: s2.id });

    [bugType] = await db.insert(schema.issueTypes).values({ name: 'Bug', isSubtask: false }).returning();
    [subType] = await db.insert(schema.issueTypes).values({ name: 'Sub-task', isSubtask: true }).returning();
    [doneStatus] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done' }).returning();
    [reviewStatus] = await db.insert(schema.statuses).values({ name: 'In Review', category: 'in_progress' }).returning();

    // Bug has its own workflow: To Do -> In Review -> Done (no "In Progress")
    [bugWorkflow] = await db.insert(schema.workflows).values({ name: 'Bug workflow' }).returning();
    await db.insert(schema.workflowTransitions).values([
      { workflowId: bugWorkflow.id, name: 'Create', fromStatusId: null, toStatusId: seeded.status.id },
      { workflowId: bugWorkflow.id, name: 'Review', fromStatusId: seeded.status.id, toStatusId: reviewStatus.id },
      { workflowId: bugWorkflow.id, name: 'Finish', fromStatusId: reviewStatus.id, toStatusId: doneStatus.id },
    ]);
    await db.insert(schema.workflowSchemeItems).values({ schemeId: (await db.select().from(schema.workflowSchemes))[0].id, issueTypeId: bugType.id, workflowId: bugWorkflow.id });
    await db.insert(schema.workflowSchemeItems).values({ schemeId: (await db.select().from(schema.workflowSchemes))[0].id, issueTypeId: subType.id, workflowId: seeded.workflow.id });

    // A custom field only the Task type carries
    const [cf] = await db.insert(schema.customFields).values({ name: 'Severity', fieldType: 'string' }).returning();
    ids.cf = cf.id;
    await db.insert(schema.customFieldContexts).values({ customFieldId: cf.id, projectId: seeded.project.id, issueTypeId: seeded.issueType.id });

    for (const u of [seeded.user.id, v.id, e.id, pa.id]) await redis.del(`veqsio:ratelimit:user:${u}`);
    await redis.del('veqsio:ratelimit:ip:unknown');
    admin = await login('admin'); viewer = await login('viewer'); editor = await login('editor'); padmin = await login('padmin');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  /* ------------------------------ time in status ----------------------------- */

  test('time in status: segments, totals and who moved it; hidden issues are 404', async () => {
    const key = await create('Timed');
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    const day = 86_400_000;
    const t = Date.now();
    await db.update(schema.issues).set({ createdAt: new Date(t - 5 * day) }).where(eq(schema.issues.id, issue.id));
    await db.insert(schema.issueHistory).values([
      { issueId: issue.id, fieldName: 'status', oldValue: 'To Do', newValue: 'In Progress', authorId: seeded.user.id, createdAt: new Date(t - 3 * day) },
      { issueId: issue.id, fieldName: 'status', oldValue: 'In Progress', newValue: 'Done', authorId: seeded.user.id, createdAt: new Date(t - 1 * day) },
    ]);
    await db.update(schema.issues).set({ statusId: doneStatus.id }).where(eq(schema.issues.id, issue.id));
    const res = await req('GET', `/rest/api/2/issue/${key}/time-in-status`, viewer);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.segments.map((s: any) => s.status)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(body.segments[0].durationMs).toBe(2 * day);
    expect(body.segments[1].durationMs).toBe(2 * day);
    expect(body.segments[1].movedBy.displayName).toBe('Administrator');
    expect(body.segments[2].leftAt).toBeNull();
    expect(body.byCategory.find((c: any) => c.category === 'in_progress').durationMs).toBe(2 * day);
    expect(body.totalMs).toBeGreaterThanOrEqual(5 * day);
    // an issue in a project the caller cannot see does not exist for them
    await db.insert(schema.issues).values({ issueKey: 'SEC-1', projectId: ids.sec, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 's', reporterId: seeded.user.id });
    expect((await req('GET', '/rest/api/2/issue/SEC-1/time-in-status', viewer)).status).toBe(404);
    expect((await req('GET', '/rest/api/2/issue/SEC-1/time-in-status', admin)).status).toBe(200);
    expect((await req('GET', '/rest/api/2/issue/NOPE-1/time-in-status', viewer)).status).toBe(404);
    expect((await app.request(`/rest/api/2/issue/${key}/time-in-status`)).status).toBe(401);
  });

  test('average time in status report per project, board and sprint, trimmed by browse', async () => {
    const proj = await json(await req('GET', '/rest/api/2/reports/time-in-status?project=TEST', viewer));
    expect(proj.scope).toEqual({ type: 'project', id: 'TEST', name: 'Test Project' });
    expect(proj.issueCount).toBeGreaterThanOrEqual(1);
    const todo = proj.statuses.find((s: any) => s.status === 'To Do');
    expect(todo.issues).toBeGreaterThanOrEqual(1);
    expect(todo.avgMs).toBeGreaterThan(0);
    expect(proj.categories.length).toBeGreaterThan(0);

    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id }).returning();
    const [sprint] = await db.insert(schema.sprints).values({ name: 'S1', boardId: board.id, state: 'active' }).returning();
    const [first] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-1'));
    await db.insert(schema.sprintIssues).values({ sprintId: sprint.id, issueId: first.id });
    const b = await json(await req('GET', `/rest/api/2/reports/time-in-status?boardId=${board.id}`, viewer));
    expect(b.scope.type).toBe('board');
    const s = await json(await req('GET', `/rest/api/2/reports/time-in-status?sprintId=${sprint.id}`, viewer));
    expect(s.scope).toEqual({ type: 'sprint', id: sprint.id, name: 'S1' });
    expect(s.issueCount).toBe(1);

    // hidden project / board / sprint are 404, bad parameters 400
    const [secBoard] = await db.insert(schema.boards).values({ name: 'SB', type: 'kanban', projectId: ids.sec }).returning();
    expect((await req('GET', '/rest/api/2/reports/time-in-status?project=SEC', viewer)).status).toBe(404);
    expect((await req('GET', `/rest/api/2/reports/time-in-status?boardId=${secBoard.id}`, viewer)).status).toBe(404);
    expect((await req('GET', '/rest/api/2/reports/time-in-status?project=SEC', admin)).status).toBe(200);
    expect((await req('GET', '/rest/api/2/reports/time-in-status', viewer)).status).toBe(400);
    expect((await req('GET', '/rest/api/2/reports/time-in-status?project=TEST&boardId=1', viewer)).status).toBe(400);
    expect((await req('GET', '/rest/api/2/reports/time-in-status?sprintId=abc', viewer)).status).toBe(404);
    expect((await app.request('/rest/api/2/reports/time-in-status?project=TEST')).status).toBe(401);
  });

  /* --------------------------- description versions -------------------------- */

  test('description versions: list, diff, restore creates a new version and a history entry', async () => {
    const key = await create('Versioned', seeded.issueType.id, { description: 'first\nline two' });
    expect((await json(await req('GET', `/rest/api/2/issue/${key}/description-history`, viewer))).versions).toEqual([]);
    expect([200, 204]).toContain((await req('PUT', `/rest/api/2/issue/${key}`, admin, { fields: { description: 'second\nline two' } })).status);
    expect([200, 204]).toContain((await req('PUT', `/rest/api/2/issue/${key}`, admin, { fields: { description: 'third\nline two\nline three' } })).status);

    const list = await json(await req('GET', `/rest/api/2/issue/${key}/description-history`, viewer));
    expect(list.versions.map((x: any) => x.version)).toEqual([3, 2, 1]);
    expect(list.versions[0].current).toBe(true);
    expect(list.versions[0].added).toBeGreaterThan(0);
    expect(list.versions[2].author.displayName).toBe('Administrator');

    const v1 = await json(await req('GET', `/rest/api/2/issue/${key}/description-history/1`, viewer));
    expect(v1.text).toBe('first\nline two');
    expect(v1.diffFromPrevious).toBeNull();
    expect(v1.diffToCurrent.some((op: any) => op.type === 'add' && op.text === 'line three')).toBe(true);
    const v3 = await json(await req('GET', `/rest/api/2/issue/${key}/description-history/3`, viewer));
    expect(v3.diffFromPrevious.some((op: any) => op.type === 'del' && op.text === 'second')).toBe(true);
    expect(v3.diffToCurrent).toBeNull();
    expect((await req('GET', `/rest/api/2/issue/${key}/description-history/9`, viewer)).status).toBe(404);
    expect((await req('GET', `/rest/api/2/issue/${key}/description-history/x`, viewer)).status).toBe(404);

    // viewers may read but not restore; editors restore; restoring the current version is a 409
    expect((await req('POST', `/rest/api/2/issue/${key}/description-history/1/restore`, viewer)).status).toBe(403);
    expect((await req('POST', `/rest/api/2/issue/${key}/description-history/3/restore`, editor)).status).toBe(409);
    const restored = await req('POST', `/rest/api/2/issue/${key}/description-history/1/restore`, editor);
    expect(restored.status).toBe(200);
    expect((await json(restored)).newVersion).toBe(4);
    const issue = await json(await req('GET', `/rest/api/2/issue/${key}`, viewer));
    expect(issue.fields.description).toBe('first\nline two');
    const after = await json(await req('GET', `/rest/api/2/issue/${key}/description-history`, viewer));
    expect(after.versions.map((x: any) => x.version)).toEqual([4, 3, 2, 1]);
    expect(after.versions[0].author.displayName).toBe('editor');
    const changelog = await json(await req('GET', `/rest/api/2/issue/${key}/changelog`, viewer));
    expect(changelog.histories.filter((h: any) => h.items[0].field === 'description')).toHaveLength(3);
    // hidden issue
    expect((await req('GET', '/rest/api/2/issue/SEC-1/description-history', viewer)).status).toBe(404);
    expect((await app.request(`/rest/api/2/issue/${key}/description-history`)).status).toBe(401);
  });

  /* -------------------------------- type switch ------------------------------ */

  test('type switch preview and apply: dropped fields go to the description, status must be mapped', async () => {
    const key = await create('Switch me');
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    await db.insert(schema.customFieldValues).values({ issueId: issue.id, customFieldId: ids.cf, stringValue: 'Critical' });
    // move it to "In Progress", which the Bug workflow does not have
    await db.update(schema.issues).set({ statusId: seeded.status2.id, description: 'Original text' }).where(eq(schema.issues.id, issue.id));

    const preview = await json(await req('POST', `/rest/api/2/issue/${key}/change-type?preview=true`, editor, { issueTypeId: bugType.id }));
    expect(preview.preview).toBe(true);
    expect(preview.from.name).toBe('Task');
    expect(preview.to.name).toBe('Bug');
    expect(preview.droppedFields).toEqual([{ id: `customfield_${ids.cf}`, name: 'Severity', value: 'Critical' }]);
    expect(preview.workflow.changed).toBe(true);
    expect(preview.status.needsMapping).toBe(true);
    expect(preview.status.available.map((s: any) => s.name)).toContain('In Review');
    expect(preview.status.suggestedStatusId).toBe(reviewStatus.id); // same category (in progress)
    expect(preview.canApply).toBe(false);
    expect(preview.newDescription).toContain('Original text');
    expect(preview.newDescription).toContain('- **Severity:** Critical');
    // a preview changes nothing
    expect((await json(await req('GET', `/rest/api/2/issue/${key}`, admin))).fields.issuetype.name).toBe('Task');

    // applying without a mapped status is refused, an unknown status too
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: bugType.id })).status).toBe(409);
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: bugType.id, statusId: seeded.status2.id })).status).toBe(409);

    const done = await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: bugType.id, statusId: reviewStatus.id });
    expect(done.status).toBe(200);
    const after = await json(await req('GET', `/rest/api/2/issue/${key}`, admin));
    expect(after.fields.issuetype.name).toBe('Bug');
    expect(after.fields.status.name).toBe('In Review');
    expect(after.fields.description).toContain('Warning: fields removed by the type change Task -> Bug');
    expect(after.fields.description).toContain('Critical');
    const remaining = await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.issueId, issue.id));
    expect(remaining).toHaveLength(0);
    const hist = (await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issue.id))).map((h) => h.fieldName);
    expect(hist).toEqual(expect.arrayContaining(['issuetype', 'status', 'description', `customfield_${ids.cf}`]));
    // the removed description is also a description version
    const versions = await json(await req('GET', `/rest/api/2/issue/${key}/description-history`, viewer));
    expect(versions.versions.length).toBe(2);
    // audit entry
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'ISSUE_TYPE_CHANGED'));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // same type again, viewer and unknown type
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: bugType.id })).status).toBe(400);
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, viewer, { issueTypeId: seeded.issueType.id })).status).toBe(403);
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: 99999 })).status).toBe(404);
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: 'x' })).status).toBe(400);
    expect((await req('POST', `/rest/api/2/issue/${key}/change-type`, editor, { issueTypeId: seeded.issueType.id, extra: 1 })).status).toBe(400);
    expect((await app.request(`/rest/api/2/issue/${key}/change-type`, { method: 'POST' })).status).toBe(401);
    expect((await req('POST', '/rest/api/2/issue/SEC-1/change-type', editor, { issueTypeId: bugType.id })).status).toBe(404);
  });

  test('type switch: sub-task rules', async () => {
    const parent = await create('Parent');
    const child = await create('Child');
    // standard -> sub-task needs a parent
    const p1 = await json(await req('POST', `/rest/api/2/issue/${child}/change-type?preview=true`, editor, { issueTypeId: subType.id }));
    expect(p1.canApply).toBe(false);
    expect(p1.parent.required).toBe(true);
    expect((await req('POST', `/rest/api/2/issue/${child}/change-type`, editor, { issueTypeId: subType.id })).status).toBe(409);
    expect((await req('POST', `/rest/api/2/issue/${child}/change-type`, editor, { issueTypeId: subType.id, parentKey: child })).status).toBe(409);
    expect((await req('POST', `/rest/api/2/issue/${child}/change-type`, editor, { issueTypeId: subType.id, parentKey: 'TEST-9999' })).status).toBe(409);
    const ok = await req('POST', `/rest/api/2/issue/${child}/change-type`, editor, { issueTypeId: subType.id, parentKey: parent });
    expect(ok.status).toBe(200);
    const c1 = await json(await req('GET', `/rest/api/2/issue/${child}`, admin));
    expect(c1.fields.issuetype.name).toBe('Sub-task');
    expect(c1.fields.parent.key).toBe(parent);
    // a parent with sub-tasks cannot become a sub-task
    const other = await create('Other');
    const blocked = await json(await req('POST', `/rest/api/2/issue/${parent}/change-type?preview=true`, editor, { issueTypeId: subType.id, parentKey: other }));
    expect(blocked.canApply).toBe(false);
    expect(blocked.blockers.join(' ')).toContain('sub-task');
    // sub-task -> standard leaves the parent
    const back = await req('POST', `/rest/api/2/issue/${child}/change-type`, editor, { issueTypeId: seeded.issueType.id });
    expect(back.status).toBe(200);
    const c2 = await json(await req('GET', `/rest/api/2/issue/${child}`, admin));
    expect(c2.fields.issuetype.name).toBe('Task');
    expect(c2.fields.parent ?? null).toBeNull();
  });

  /* ------------------------------ workflow governance ------------------------ */

  test('a status can be closed for new issues', async () => {
    const r = await req('PUT', `/rest/api/2/admin/status/${seeded.status.id}`, admin, { allowNewIssues: false });
    expect(r.status).toBe(200);
    expect((await json(r)).allowNewIssues).toBe(false);
    const refused = await req('POST', '/rest/api/2/issue', admin, { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'nope' } });
    expect(refused.status).toBe(400);
    expect((await json(refused)).errorMessages[0]).toContain('closed for new issues');
    const list = await json(await req('GET', '/rest/api/2/admin/status', admin));
    expect(list.statuses.find((s: any) => s.id === seeded.status.id).allowNewIssues).toBe(false);
    expect((await req('PUT', `/rest/api/2/admin/status/${seeded.status.id}`, viewer, { allowNewIssues: true })).status).toBe(403);
    await req('PUT', `/rest/api/2/admin/status/${seeded.status.id}`, admin, { allowNewIssues: true });
    await create('allowed again');
  });

  test('workflow change history records transitions, conditions and statuses; the designer shows who may move', async () => {
    const wfId = seeded.workflow.id;
    const created = await json(await req('POST', `/rest/api/2/admin/workflow/${wfId}/transition`, admin, {
      name: 'Complete', fromStatusId: seeded.status2.id, toStatusId: doneStatus.id, conditions: [{ type: 'always_true' }],
    }));
    const tid = created.id;
    expect((await req('PUT', `/rest/api/2/admin/workflow/${wfId}/transition/${tid}`, admin, { name: 'Finish work', conditions: [] })).status).toBe(200);
    await req('PUT', `/rest/api/2/admin/status/${doneStatus.id}`, admin, { name: 'Completed', allowNewIssues: false });
    expect((await req('DELETE', `/rest/api/2/admin/workflow/${wfId}/transition/${tid}`, admin)).status).toBe(200);

    const hist = await json(await req('GET', `/rest/api/2/admin/workflow/${wfId}/history`, admin));
    const summaries: string[] = hist.entries.map((e: any) => e.summary);
    expect(summaries.some((s) => s.includes('Transition "Complete" created'))).toBe(true);
    expect(summaries.some((s) => s.includes('Condition added on transition "Complete"'))).toBe(true);
    expect(summaries.some((s) => s.includes('Condition removed from transition "Finish work"'))).toBe(true);
    expect(summaries.some((s) => s.includes('renamed from "Complete"'))).toBe(true);
    expect(summaries.some((s) => s.includes('Status "Completed"') && s.includes('no longer allowed'))).toBe(true);
    expect(summaries.some((s) => s.includes('deleted'))).toBe(true);
    expect(hist.entries[0].actor.name).toBe('Administrator');
    expect(new Date(hist.entries[0].at).getTime()).toBeGreaterThan(0);
    expect((await req('GET', `/rest/api/2/admin/workflow/${wfId}/history`, viewer)).status).toBe(403);
    expect((await req('GET', '/rest/api/2/admin/workflow/99999/history', admin)).status).toBe(404);
    expect((await app.request(`/rest/api/2/admin/workflow/${wfId}/history`)).status).toBe(401);

    // who-may-move hint on every transition of the designer detail
    const detail = await json(await req('GET', `/rest/api/2/admin/workflow/${wfId}`, admin));
    expect(detail.transitions.length).toBeGreaterThan(0);
    expect(detail.transitions.every((t: any) => typeof t.whoMayMove === 'string' && t.whoMayMove.length > 0)).toBe(true);
    expect(detail.statuses.every((s: any) => typeof s.allowNewIssues === 'boolean')).toBe(true);
    await req('PUT', `/rest/api/2/admin/status/${doneStatus.id}`, admin, { name: 'Done', allowNewIssues: true });
  });

  test('workflowGovernance: constrained forbids project admins from reassigning the workflow scheme', async () => {
    const [scheme2] = await db.insert(schema.workflowSchemes).values({ name: 'Other scheme' }).returning();
    const url = '/rest/api/2/project/TEST/workflow-scheme';
    // default is "any"
    const defaults = await json(await req('GET', '/rest/api/2/admin/settings', admin));
    const def = (defaults.settings ?? defaults).find?.((s: any) => s.key === 'workflowGovernance');
    if (def) expect(def.value ?? def.default).toBe('any');
    const info = await json(await req('GET', url, padmin));
    expect(info.governance).toBe('any');
    expect(info.canChange).toBe(true);
    expect((await req('PUT', url, padmin, { schemeId: scheme2.id })).status).toBe(200);
    expect((await req('PUT', url, editor, { schemeId: scheme2.id })).status).toBe(403);
    expect((await req('PUT', url, padmin, { schemeId: 99999 })).status).toBe(404);
    expect((await req('PUT', url, padmin, { schemeId: 'x' })).status).toBe(400);

    expect((await req('PUT', '/rest/api/2/admin/settings', admin, { workflowGovernance: 'bogus' })).status).toBe(400);
    expect((await req('PUT', '/rest/api/2/admin/settings', admin, { workflowGovernance: 'constrained' })).status).toBe(200);
    invalidateInstanceSettings();
    const info2 = await json(await req('GET', url, padmin));
    expect(info2.governance).toBe('constrained');
    expect(info2.canChange).toBe(false);
    const refused = await req('PUT', url, padmin, { schemeId: seeded.permScheme.id });
    expect(refused.status).toBe(403);
    expect((await json(refused)).errorMessages[0]).toContain('constrained');
    // system administrators still can, through the project route and the admin route
    expect((await req('PUT', url, admin, { schemeId: scheme2.id })).status).toBe(200);
    expect((await req('POST', `/rest/api/2/admin/workflowscheme/${scheme2.id}/assign`, admin, { projectId: seeded.project.id })).status).toBe(200);
    expect((await req('POST', `/rest/api/2/admin/workflowscheme/${scheme2.id}/assign`, padmin, { projectId: seeded.project.id })).status).toBe(403);
    // viewers cannot even see a hidden project
    expect((await req('GET', '/rest/api/2/project/SEC/workflow-scheme', viewer)).status).toBe(404);
    expect((await app.request(url)).status).toBe(401);
    await req('PUT', '/rest/api/2/admin/settings', admin, { workflowGovernance: 'any' });
    invalidateInstanceSettings();
  });

  /* ------------------------------------ JQL --------------------------------- */

  test('JQL LIMIT caps the result set and still pages', async () => {
    const q = (jql: string, extra = '') => req('GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}${extra}`, admin);
    const all = await json(await q('project = TEST ORDER BY created ASC'));
    expect(all.total).toBeGreaterThan(5);
    const lim = await json(await q('project = TEST ORDER BY created ASC LIMIT 3'));
    expect(lim.total).toBe(3);
    expect(lim.issues).toHaveLength(3);
    expect(lim.issues.map((i: any) => i.key)).toEqual(all.issues.slice(0, 3).map((i: any) => i.key));
    // paging inside the limit
    const page = await json(await q('project = TEST ORDER BY created ASC LIMIT 3', '&startAt=2&maxResults=5'));
    expect(page.issues).toHaveLength(1);
    expect(page.total).toBe(3);
    expect((await json(await q('project = TEST ORDER BY created ASC LIMIT 3', '&startAt=5'))).issues).toHaveLength(0);
    // maxResults smaller than the limit still wins
    expect((await json(await q('project = TEST ORDER BY created ASC LIMIT 3', '&maxResults=2'))).issues).toHaveLength(2);
    // limit larger than the matches is harmless; no LIMIT keeps the old behaviour
    expect((await json(await q('project = TEST LIMIT 1000'))).total).toBe(all.total);
    expect((await q('project = TEST LIMIT 1001')).status).toBe(400);
    expect((await q('project = TEST LIMIT 0')).status).toBe(400);
  });

  test('JQL relation helpers: linkedIssues, blockedBy, blocking, subtasksOf, issuesWithoutParent', async () => {
    const a = await create('A blocker'), b = await create('B blocked'), c = await create('C related'), d = await create('D unrelated');
    const row = async (k: string) => (await db.select().from(schema.issues).where(eq(schema.issues.issueKey, k)))[0];
    const [blocks] = await db.insert(schema.linkTypes).values({ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }).returning();
    const [relates] = await db.insert(schema.linkTypes).values({ name: 'Relates', inward: 'relates to', outward: 'relates to' }).returning();
    // B "is blocked by" A: issue_id = B (inward sentence), linked_issue_id = A (outward sentence)
    await db.insert(schema.issueLinks).values([
      { issueId: (await row(b)).id, linkedIssueId: (await row(a)).id, linkTypeId: blocks.id },
      { issueId: (await row(c)).id, linkedIssueId: (await row(a)).id, linkTypeId: relates.id },
    ]);
    const keys = async (jql: string) => {
      const r = await req('GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100`, admin);
      expect(r.status).toBe(200);
      return ((await json(r)).issues as any[]).map((i) => i.key).sort();
    };
    expect(await keys(`key in linkedIssues("${a}")`)).toEqual([b, c].sort());
    expect(await keys(`key in linkedIssues("${a}", "blocks")`)).toEqual([b]);
    expect(await keys(`key in linkedIssues("${a}", "relates")`)).toEqual([c]);
    expect(await keys(`key in linkedIssues("${b}", "is blocked by")`)).toEqual([a]);
    expect(await keys(`key in linkedIssues("${a}", "is blocked by")`)).toEqual([]);
    expect(await keys(`key in blocking("${a}")`)).toEqual([b]);
    expect(await keys(`key in blockedBy("${b}")`)).toEqual([a]);
    expect(await keys(`key in blockedBy("${a}")`)).toEqual([]);
    expect(await keys(`key in linkedIssues("${a}") AND key not in blocking("${a}")`)).toEqual([c]);
    expect(await keys(`project = TEST AND key not in linkedIssues("${a}") AND key in (${d})`)).toEqual([d]);
    // sub-tasks and issues without a parent
    const [ai] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, a));
    await db.update(schema.issues).set({ parentId: ai.id }).where(eq(schema.issues.issueKey, d));
    expect(await keys(`key in subtasksOf("${a}")`)).toEqual([d]);
    const noParent = await keys('key in issuesWithoutParent() AND project = TEST');
    expect(noParent).toContain(a);
    expect(noParent).not.toContain(d);
    // errors
    expect((await req('GET', `/rest/api/2/search?jql=${encodeURIComponent('status in blocking("TEST-1")')}`, admin)).status).toBe(400);
    expect((await req('GET', `/rest/api/2/search?jql=${encodeURIComponent('key in blocking()')}`, admin)).status).toBe(400);
    // results stay trimmed to browsable projects
    await db.insert(schema.issues).values({ issueKey: 'SEC-2', projectId: ids.sec, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'x', reporterId: seeded.user.id });
    const [s2] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'SEC-2'));
    await db.insert(schema.issueLinks).values({ issueId: s2.id, linkedIssueId: ai.id, linkTypeId: blocks.id });
    const viewerKeys = ((await json(await req('GET', `/rest/api/2/search?jql=${encodeURIComponent(`key in linkedIssues("${a}")`)}`, viewer))).issues as any[]).map((i) => i.key);
    expect(viewerKeys).not.toContain('SEC-2');
    expect(await keys(`key in linkedIssues("${a}") ORDER BY key ASC`)).toContain("SEC-2");
  });
});
