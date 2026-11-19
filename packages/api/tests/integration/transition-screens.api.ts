import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidatePermissionCache } from '../../src/rbac/service';

/** Transition screens: fields collected during a workflow transition, validated and applied atomically. */
describe('Transition screens', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: any;
  let cookie = '', userCookie = '';
  let userId = 0, bobId = 0;
  let screenId = 0, tabId = 0, noScreenTransition = 0, screenTransition = 0, doneStatusId = 0;
  let versionId = 0, componentId = 0, customNumberId = 0, customSelectId = 0, priorityHighId = 0;

  const send = (c: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });
  const admin = (method: string, path: string, body?: unknown) => send(cookie, method, path, body);
  const login = async (username: string) => (await app.request('/rest/auth/1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
  })).headers.get('set-cookie') || '';

  async function createIssue(summary: string) {
    const res = await admin('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; key: string };
  }
  const transition = (key: string, id: number, fields?: Record<string, unknown>, who = cookie) =>
    send(who, 'POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id }, fields });
  const row = async (id: number) => (await db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0];
  const historyCount = async (id: number) => (await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, id))).length;
  const commentCount = async (id: number) => (await db.select().from(schema.comments).where(eq(schema.comments.issueId, id))).length;
  async function addScreenField(body: Record<string, unknown>) {
    const res = await admin('POST', `/rest/api/2/admin/screen/${screenId}/tab/${tabId}/field`, body);
    return res;
  }
  async function resetScreen() {
    await db.delete(schema.screenTabFields).where(eq(schema.screenTabFields.tabId, tabId));
  }

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    userId = seeded.user.id;
    const [bob] = await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash }).returning();
    bobId = bob.id;
    await invalidatePermissionCache();
    cookie = await login('admin');
    userCookie = await login('bob');
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#16A06A' }).returning();
    doneStatusId = done.id;
    await db.insert(schema.resolutions).values({ name: 'Fixed' });
    const [high] = await db.insert(schema.priorities).values({ name: 'High', color: '#f00' }).returning();
    priorityHighId = high.id;
    const [v] = await db.insert(schema.versions).values({ name: '1.0', projectId: seeded.project.id }).returning();
    versionId = v.id;
    const [comp] = await db.insert(schema.components).values({ name: 'Backend', projectId: seeded.project.id }).returning();
    componentId = comp.id;
    const [cn] = await db.insert(schema.customFields).values({ name: 'Effort', fieldType: 'number' }).returning();
    customNumberId = cn.id;
    const [cs] = await db.insert(schema.customFields).values({ name: 'Team', fieldType: 'select' }).returning();
    customSelectId = cs.id;
    const [ctx] = await db.insert(schema.customFieldContexts).values({ customFieldId: cs.id }).returning();
    await db.insert(schema.customFieldOptions).values([{ customFieldId: cs.id, contextId: ctx.id, value: 'Red' }, { customFieldId: cs.id, contextId: ctx.id, value: 'Blue' }]);

    // The seeded transition has no screen; add one that does.
    const [plain] = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, seeded.workflow.id));
    noScreenTransition = plain.id;
    let r = await admin('POST', '/rest/api/2/admin/screen', { name: 'Resolve screen' });
    screenId = (await r.json()).id;
    r = await admin('POST', `/rest/api/2/admin/screen/${screenId}/tab`, { name: 'Fields' });
    tabId = (await r.json()).id;
    const [t] = await db.insert(schema.workflowTransitions).values({
      workflowId: seeded.workflow.id, name: 'Finish', fromStatusId: seeded.status2.id, toStatusId: doneStatusId, screenId,
      conditions: [{ type: 'always_true' }], validators: [], postFunctions: [],
    }).returning();
    screenTransition = t.id;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  /** Moves a fresh issue to In Progress so the "Finish" transition applies. */
  async function inProgress(summary: string) {
    const issue = await createIssue(summary);
    expect((await transition(issue.key, noScreenTransition)).status).toBe(200);
    return issue;
  }

  describe('admin: screen fields', () => {
    test('the catalog lists the system fields and custom fields; only system administrators may use it', async () => {
      const body = await (await admin('GET', '/rest/api/2/admin/screen-fields')).json();
      const keys = body.fields.map((f: any) => f.key);
      for (const k of ['resolution', 'assignee', 'priority', 'labels', 'fixVersions', 'components', 'duedate', 'storyPoints', 'environment', 'comment', `customfield_${customNumberId}`]) expect(keys).toContain(k);
      expect((await send(userCookie, 'GET', '/rest/api/2/admin/screen-fields')).status).toBe(403);
    });
    test('add a system field and a custom field, mark one required, reject duplicates and unknown fields', async () => {
      await resetScreen();
      const a = await addScreenField({ fieldKey: 'assignee', required: true });
      expect(a.status).toBe(201);
      expect((await addScreenField({ fieldKey: 'assignee' })).status).toBe(409);
      expect((await addScreenField({ fieldKey: 'nonsense' })).status).toBe(400);
      expect((await addScreenField({ fieldKey: 'priority' })).status).toBe(201);
      expect((await addScreenField({ fieldId: customNumberId, isCustomField: true })).status).toBe(201);
      expect((await addScreenField({ fieldId: 99999, isCustomField: true })).status).toBe(400);
      const list = await (await admin('GET', '/rest/api/2/admin/screen')).json();
      const fields = list.screens.find((s: any) => s.id === screenId).tabs[0].fields;
      expect(fields.map((f: any) => f.fieldKey ?? `customfield_${f.fieldId}`)).toEqual(['assignee', 'priority', `customfield_${customNumberId}`]);
      expect(fields[0].required).toBe(true);
      const id = (await a.json()).id;
      expect((await admin('PUT', `/rest/api/2/admin/screen/${screenId}/tab/${tabId}/field/${id}`, { required: false })).status).toBe(200);
      expect((await admin('PUT', `/rest/api/2/admin/screen/${screenId}/tab/${tabId}/field/${id}`, { required: true })).status).toBe(200);
      expect((await send(userCookie, 'POST', `/rest/api/2/admin/screen/${screenId}/tab/${tabId}/field`, { fieldKey: 'labels' })).status).toBe(403);
    });
  });

  describe('GET transitions', () => {
    test('describes the screen fields in order, with required flags and options', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'resolution', required: true });
      await addScreenField({ fieldKey: 'assignee' });
      await addScreenField({ fieldId: customSelectId, isCustomField: true, required: true });
      await addScreenField({ fieldKey: 'comment' });
      const issue = await inProgress('meta');
      const list = (await (await admin('GET', `/rest/api/2/issue/${issue.key}/transitions`)).json()).transitions;
      const t = list.find((x: any) => x.id === screenTransition);
      expect(t.hasScreen).toBe(true);
      expect(t.requiresInput).toBe(true);
      expect(t.screenFields.map((f: any) => f.key)).toEqual(['resolution', 'assignee', `customfield_${customSelectId}`, 'comment']);
      expect(t.screenFields[0].required).toBe(true);
      expect(t.screenFields[1].required).toBe(false);
      expect(t.screenFields[2]).toMatchObject({ custom: true, type: 'select', options: ['Red', 'Blue'], name: 'Team' });
      expect(t.fields.assignee.required).toBe(false);
    });
    test('a transition without a screen has no screen fields', async () => {
      const issue = await createIssue('plain');
      const list = (await (await admin('GET', `/rest/api/2/issue/${issue.key}/transitions`)).json()).transitions;
      expect(list.find((x: any) => x.id === noScreenTransition).screenFields).toEqual([]);
    });
  });

  describe('required, optional and invalid fields', () => {
    test('a missing required field answers 400 with per-field errors and changes nothing', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'resolution', required: true });
      await addScreenField({ fieldKey: 'assignee', required: true });
      await addScreenField({ fieldKey: 'comment', required: true });
      await addScreenField({ fieldKey: 'priority' });
      const issue = await inProgress('missing');
      const before = { row: await row(issue.id), hist: await historyCount(issue.id), comments: await commentCount(issue.id) };
      const res = await transition(issue.key, screenTransition, { priority: { id: priorityHighId } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors).toEqual({ resolution: 'Resolution is required', assignee: 'Assignee is required', comment: 'Comment is required' });
      expect(body.validationErrors.length).toBe(3);
      const after = await row(issue.id);
      expect(after.statusId).toBe(before.row.statusId);
      expect(after.priorityId).toBe(before.row.priorityId); // the valid optional field was NOT applied either
      expect(await historyCount(issue.id)).toBe(before.hist);
      expect(await commentCount(issue.id)).toBe(before.comments);
    });
    test('optional fields may be left out: the transition runs as before', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'assignee' });
      await addScreenField({ fieldKey: 'labels' });
      const issue = await inProgress('optional');
      const res = await transition(issue.key, screenTransition);
      expect(res.status).toBe(200);
      expect((await row(issue.id)).statusId).toBe(doneStatusId);
    });
    test('a required field that already has a value may be omitted, but not cleared', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'assignee', required: true });
      const issue = await inProgress('has value');
      await db.update(schema.issues).set({ assigneeId: bobId }).where(eq(schema.issues.id, issue.id));
      const cleared = await transition(issue.key, screenTransition, { assignee: null });
      expect(cleared.status).toBe(400);
      expect((await cleared.json()).errors.assignee).toBe('Assignee is required');
      expect((await transition(issue.key, screenTransition)).status).toBe(200);
      expect((await row(issue.id)).assigneeId).toBe(bobId);
    });
    test('invalid values are rejected per field and nothing is written', async () => {
      await resetScreen();
      for (const k of ['assignee', 'priority', 'labels', 'fixVersions', 'components', 'duedate', 'storyPoints', 'environment']) await addScreenField({ fieldKey: k });
      await addScreenField({ fieldId: customNumberId, isCustomField: true });
      await addScreenField({ fieldId: customSelectId, isCustomField: true });
      const issue = await inProgress('invalid');
      const before = await historyCount(issue.id);
      const res = await transition(issue.key, screenTransition, {
        assignee: { id: 999999 }, priority: { id: 999999 }, labels: ['has space'], fixVersions: [{ id: 999999 }], components: [{ id: 999999 }],
        duedate: '2026-13-45', storyPoints: 5000, environment: 42,
        [`customfield_${customNumberId}`]: 'abc', [`customfield_${customSelectId}`]: 'Green',
      });
      expect(res.status).toBe(400);
      const errors = (await res.json()).errors;
      expect(Object.keys(errors).sort()).toEqual(['assignee', 'components', 'duedate', 'environment', 'fixVersions', 'labels', 'priority', `customfield_${customNumberId}`, `customfield_${customSelectId}`, 'storyPoints'].sort());
      expect(errors.duedate).toContain('YYYY-MM-DD');
      expect((await row(issue.id)).statusId).toBe(seeded.status2.id);
      expect(await historyCount(issue.id)).toBe(before);
    });
    test('fields that are not on the screen are ignored (the screen is the allow-list)', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'priority' });
      const issue = await inProgress('allow list');
      const res = await transition(issue.key, screenTransition, { priority: { id: priorityHighId }, assignee: { id: bobId }, summary: 'hacked' });
      expect(res.status).toBe(200);
      const r = await row(issue.id);
      expect(r.priorityId).toBe(priorityHighId);
      expect(r.assigneeId).toBeNull();
      expect(r.summary).toBe('allow list');
    });
  });

  describe('applying the fields', () => {
    test('all system fields and custom fields are applied with the status change, with ordinary history rows', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'resolution', required: true });
      for (const k of ['assignee', 'priority', 'labels', 'fixVersions', 'components', 'duedate', 'storyPoints', 'environment', 'comment']) await addScreenField({ fieldKey: k });
      await addScreenField({ fieldId: customNumberId, isCustomField: true });
      await addScreenField({ fieldId: customSelectId, isCustomField: true });
      const issue = await inProgress('apply all');
      const [res0] = await db.select().from(schema.resolutions);
      const res = await transition(issue.key, screenTransition, {
        resolution: { id: res0.id }, assignee: { id: bobId }, priority: { id: priorityHighId }, labels: ['alpha', 'beta'],
        fixVersions: [{ id: versionId }], components: [{ id: componentId }], duedate: '2026-12-24', storyPoints: 5.5, environment: 'prod eu',
        comment: 'done with screen', [`customfield_${customNumberId}`]: 8, [`customfield_${customSelectId}`]: 'Blue',
      });
      expect(res.status).toBe(200);
      const got = await (await admin('GET', `/rest/api/2/issue/${issue.key}?nocache=1`)).json();
      expect(got.fields.status.name).toBe('Done');
      expect(got.fields.resolution.name).toBe('Fixed');
      expect(got.fields.assignee.id).toBe(bobId);
      expect(got.fields.priority.id).toBe(priorityHighId);
      expect(got.fields.labels.sort()).toEqual(['alpha', 'beta']);
      expect(got.fields.fixVersions.map((x: any) => x.id)).toEqual([versionId]);
      expect(got.fields.components.map((x: any) => x.id)).toEqual([componentId]);
      expect(got.fields.duedate).toBe('2026-12-24');
      expect(got.fields.storyPoints).toBe(5.5);
      expect(got.fields.environment).toBe('prod eu');
      expect(Number(got.fields[`customfield_${customNumberId}`])).toBe(8);
      expect(got.fields[`customfield_${customSelectId}`]).toBe('Blue');
      const comments = await db.select().from(schema.comments).where(eq(schema.comments.issueId, issue.id));
      expect(comments.map((c) => c.body)).toEqual(['done with screen']);
      const hist = (await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issue.id))).map((h) => h.fieldName);
      for (const f of ['status', 'resolution', 'assignee', 'priority', 'labels', 'fixVersions', 'components', 'duedate', 'storypoints', 'environment', `customfield_${customNumberId}`]) expect(hist).toContain(f);
      // the new assignee is told, like after a normal edit
      const mails = (await testSql`SELECT to_address FROM email_queue`).map((r: any) => r.to_address);
      expect(mails).toContain('bob@example.com');
    });
    test('atomicity: a late failure (validator) rolls back the screen fields too', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'priority' });
      await addScreenField({ fieldKey: 'labels' });
      await db.update(schema.workflowTransitions).set({ validators: [{ type: 'field_required', field: 'mustHave' }] }).where(eq(schema.workflowTransitions.id, screenTransition));
      const issue = await inProgress('atomic');
      const res = await transition(issue.key, screenTransition, { priority: { id: priorityHighId }, labels: ['x'] });
      expect(res.status).toBe(400);
      const r = await row(issue.id);
      expect(r.statusId).toBe(seeded.status2.id);
      expect(r.priorityId).toBeNull();
      expect((await db.select().from(schema.issueLabels).where(eq(schema.issueLabels.issueId, issue.id))).length).toBe(0);
      await db.update(schema.workflowTransitions).set({ validators: [] }).where(eq(schema.workflowTransitions.id, screenTransition));
    });
    test('atomicity: a post function that fails after the screen was applied rolls everything back', async () => {
      await resetScreen();
      await addScreenField({ fieldKey: 'environment' });
      await addScreenField({ fieldKey: 'comment' });
      const issue = await inProgress('late failure');
      const hist = await historyCount(issue.id);
      await db.update(schema.workflowTransitions).set({ postFunctions: [{ type: 'request_approval', template: 'No such template' }] }).where(eq(schema.workflowTransitions.id, screenTransition));
      const res = await transition(issue.key, screenTransition, { environment: 'should vanish', comment: 'nor this' });
      await db.update(schema.workflowTransitions).set({ postFunctions: [] }).where(eq(schema.workflowTransitions.id, screenTransition));
      expect(res.status).toBe(400);
      const r = await row(issue.id);
      expect(r.statusId).toBe(seeded.status2.id);
      expect(r.environment).toBeNull();
      expect(await commentCount(issue.id)).toBe(0);
      expect(await historyCount(issue.id)).toBe(hist);
    });
  });

  describe('backwards compatibility', () => {
    test('a transition without a screen behaves exactly as before (extra fields ignored, comment still works)', async () => {
      const issue = await createIssue('compat');
      const res = await transition(issue.key, noScreenTransition, { priority: { id: priorityHighId }, comment: 'plain comment' });
      expect(res.status).toBe(200);
      const r = await row(issue.id);
      expect(r.statusId).toBe(seeded.status2.id);
      expect(r.priorityId).toBeNull(); // not on a screen: ignored
      expect(await commentCount(issue.id)).toBe(1);
    });
    test('an empty screen (no fields) behaves like no screen', async () => {
      await resetScreen();
      const issue = await inProgress('empty screen');
      expect((await transition(issue.key, screenTransition)).status).toBe(200);
    });
    test('permissions are unchanged: a user without access to the transition still gets refused', async () => {
      const issue = await inProgress('perm');
      const res = await transition(issue.key, screenTransition, {}, userCookie);
      expect([403, 404]).toContain(res.status);
      expect((await row(issue.id)).statusId).toBe(seeded.status2.id);
    });
  });
});
