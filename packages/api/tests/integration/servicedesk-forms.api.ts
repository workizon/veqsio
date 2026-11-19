import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Service desk creation and request form builder', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, alice: string, bob: string, carol: string;
  let highId: number, cfId: number;
  let deskId: number;
  let rtId: number;
  const SD = '/rest/servicedeskapi';

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values([
      { username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash },
      { username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash },
      { username: 'carol', email: 'carol@example.com', displayName: 'Carol', passwordHash: hash },
    ]);
    const [high] = await db.insert(schema.priorities).values({ name: 'High', color: '#f00' }).returning();
    highId = high.id;
    const [cf] = await db.insert(schema.customFields).values({ name: 'Department', fieldType: 'string' }).returning();
    cfId = cf.id;
    admin = await login('admin');
    alice = await login('alice');
    bob = await login('bob');
    carol = await login('carol');
  });

  afterAll(async () => {
    // This file is request-heavy: do not eat the shared per-user rate-limit budget of later test files.
    for (let uid = 1; uid <= 30; uid++) await redis.del(`veqsio:ratelimit:user:${uid}`);
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ---------------- creating a desk from the UI wizard ---------------- */

  test('creates a desk together with a new project (key, counter, schemes, desk admin)', async () => {
    const db = createTestDb(testSql);
    let res = await call(admin, 'POST', `${SD}/servicedesk`, {
      projectKey: 'HELP', createProject: true, projectName: 'Help Project', name: 'Help Desk', slug: 'help-desk',
      publicSignup: true, template: 'hr',
    });
    expect(res.status).toBe(201);
    const desk = await res.json();
    deskId = desk.id;
    expect(desk.projectKey).toBe('HELP');

    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'HELP'));
    expect(project.name).toBe('Help Project');
    expect(project.leadId).toBe(seeded.user.id);
    const [counter] = await db.select().from(schema.projectIssueCounters).where(eq(schema.projectIssueCounters.projectId, project.id));
    expect(counter.currentValue).toBe(0);
    const [perm] = await db.select().from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, project.id));
    expect(perm.schemeId).toBe(seeded.permScheme.id);
    const [wf] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, project.id));
    expect(wf).toBeTruthy();
    const agents = await db.select().from(schema.serviceDeskAgents).where(eq(schema.serviceDeskAgents.serviceDeskId, deskId));
    expect(agents.map((a) => a.role)).toEqual(['admin']);

    // HR template created request types
    res = await call(admin, 'GET', `${SD}/servicedesk/${deskId}/requesttype`);
    const names = (await res.json()).values.map((t: any) => t.name);
    expect(names).toContain('Request time off');

    // listed with the project key
    res = await call(admin, 'GET', `${SD}/servicedesk`);
    expect((await res.json()).values.find((d: any) => d.id === deskId).projectKey).toBe('HELP');
  });

  test('project creation is guarded: permission, key shape, duplicates, strict body', async () => {
    let res = await call(alice, 'POST', `${SD}/servicedesk`, { projectKey: 'NEWK', createProject: true, name: 'x', slug: 'x-desk' });
    expect(res.status).toBe(403);
    res = await call(admin, 'POST', `${SD}/servicedesk`, { projectKey: 'lower', createProject: true, name: 'x', slug: 'x-desk' });
    expect(res.status).toBe(400);
    res = await call(admin, 'POST', `${SD}/servicedesk`, { projectKey: 'HELP', createProject: true, name: 'x', slug: 'x-desk' });
    expect(res.status).toBe(409);
    res = await call(admin, 'POST', `${SD}/servicedesk`, { projectKey: 'ZZ', createProject: true, name: 'x', slug: 'help-desk' });
    expect(res.status).toBe(409); // slug taken, and the project insert is rolled back
    const db = createTestDb(testSql);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'ZZ'))).length).toBe(0);
    res = await call(admin, 'POST', `${SD}/servicedesk`, { projectKey: 'ZZ', createProject: true, name: 'x', slug: 'zz-desk', isAdmin: true });
    expect(res.status).toBe(400);
  });

  /* ---------------- form builder API ---------------- */

  test('admin builds a request type with the new field types; invalid forms are rejected', async () => {
    const fields = [
      { key: 'subject', label: 'Subject', type: 'text', required: true, mapping: { target: 'summary' }, helpText: 'Short title', placeholder: 'e.g. Laptop' },
      { key: 'kind', label: 'Kind', type: 'select', required: true, options: ['Hardware', 'Software'] },
      { key: 'serial', label: 'Serial number', type: 'text', required: true, visibleWhen: { field: 'kind', value: 'Hardware' }, validation: { minLength: 3, pattern: '^[A-Z0-9-]+$' } },
      { key: 'urgency', label: 'Urgency', type: 'radio', options: ['Normal', 'High'], mapping: { target: 'priority' } },
      { key: 'tags', label: 'Tags', type: 'checkboxes', options: ['network', 'printer'], mapping: { target: 'labels' } },
      { key: 'due', label: 'Needed by', type: 'date', mapping: { target: 'dueDate' } },
      { key: 'dept', label: 'Department', type: 'text', mapping: { target: 'customField', customFieldId: cfId } },
      { key: 'contact', label: 'Alternate contact', type: 'user', mapping: { target: 'assignee' } },
      { key: 'triage', label: 'Triage label', type: 'select', options: ['t1', 't2'], internal: true, defaultValue: 't2', mapping: { target: 'labels' } },
      { key: 'agentNote', label: 'Agent only note', type: 'text', internal: true },
      { key: 'help', label: 'Please read', type: 'help', helpText: 'We reply within a day' },
    ];
    let res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, {
      name: 'Equipment request', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id, fields,
    });
    expect(res.status).toBe(201);
    const rt = await res.json();
    rtId = rt.id;
    expect(rt.visibility).toBe('all');

    // invalid forms: duplicate key, reserved key, bad condition, unknown mapping key, unknown field prop, unknown custom field
    const bad = async (f: any[]) => call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, { name: 'Bad', issueTypeId: seeded.issueType.id, fields: f });
    res = await bad([{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'A', type: 'text' }]);
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages.join()).toContain('duplicate field key');
    expect((await bad([{ key: 'constructor', label: 'C', type: 'text' }])).status).toBe(400);
    expect((await bad([{ key: 'a', label: 'A', type: 'text', visibleWhen: { field: 'zz', value: 1 } }])).status).toBe(400);
    expect((await bad([{ key: 'a', label: 'A', type: 'text', mapping: { target: 'summary', evil: 1 } }])).status).toBe(400);
    expect((await bad([{ key: 'a', label: 'A', type: 'text', isAdmin: true }])).status).toBe(400);
    expect((await bad([{ key: 'a', label: 'A', type: 'text', validation: { pattern: '(a+)+$' } }])).status).toBe(400);
    res = await bad([{ key: 'a', label: 'A', type: 'text', mapping: { target: 'customField', customFieldId: 99999 } }]);
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages.join()).toContain('unknown custom field');
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, { name: 'Bad', issueTypeId: 99999, fields: [] });
    expect(res.status).toBe(400);
  });

  test('agents have read-only access; non-members and customers get 404', async () => {
    let res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/agent`, { email: 'Bob@Example.com' });
    expect(res.status).toBe(204);
    res = await call(bob, 'GET', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).fields.length).toBeGreaterThan(5);
    res = await call(bob, 'PUT', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`, { name: 'hacked' });
    expect(res.status).toBe(403);
    res = await call(bob, 'POST', `${SD}/servicedesk/${deskId}/requesttype/${rtId}/duplicate`);
    expect(res.status).toBe(403);
    res = await call(bob, 'GET', `${SD}/servicedesk/${deskId}/formcontext`);
    expect(res.status).toBe(403);
    res = await call(bob, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { portalTitle: 'x' });
    expect(res.status).toBe(403);
    res = await call(carol, 'GET', `${SD}/servicedesk/${deskId}/requesttype`);
    expect(res.status).toBe(404);
  });

  test('form context lists custom fields, priorities, issue types', async () => {
    const res = await call(admin, 'GET', `${SD}/servicedesk/${deskId}/formcontext`);
    expect(res.status).toBe(200);
    const ctx = await res.json();
    expect(ctx.customFields.map((c: any) => c.name)).toContain('Department');
    expect(ctx.priorities.map((p: any) => p.name)).toContain('High');
    expect(ctx.issueTypes.length).toBeGreaterThan(0);
  });

  /* ---------------- portal: internal fields never leak ---------------- */

  test('portal never exposes internal-only fields or mapping configuration', async () => {
    const res = await call(alice, 'GET', `${SD}/portal/help-desk`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('agentNote');
    expect(text).not.toContain('Agent only note');
    expect(text).not.toContain('triage');
    expect(text).not.toContain('"mapping"');
    expect(text).not.toContain('customFieldId');
    const portal = JSON.parse(text);
    const t = portal.requestTypes.find((x: any) => x.id === rtId);
    expect(t.fields.map((f: any) => f.key)).toEqual(['subject', 'kind', 'serial', 'urgency', 'tags', 'due', 'dept', 'contact', 'help']);
    expect(t.summaryField).toBe(true);
    expect(t.descriptionField).toBe(false);
    // visibility rules and validation are needed by the client and stay visible
    expect(t.fields.find((f: any) => f.key === 'serial').visibleWhen).toEqual({ field: 'kind', value: 'Hardware' });
  });

  test('hidden required fields do not block submission; mapped values land on the issue; internal values are ignored', async () => {
    const db = createTestDb(testSql);
    const post = (fv: any, extra: any = {}) => call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: rtId, fieldValues: fv, ...extra });

    // serial is required only for Hardware
    let res = await post({ subject: 'New mouse', kind: 'Software' });
    expect(res.status).toBe(201);
    res = await post({ subject: 'New laptop', kind: 'Hardware' });
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages).toEqual(['Serial number is required']);
    res = await post({ subject: 'New laptop', kind: 'Hardware', serial: 'ab' });
    expect(res.status).toBe(400);
    res = await post({ subject: 'x', kind: 'Software', serial: 'lowercase-ignored-because-hidden' });
    expect(res.status).toBe(201);
    // no summary at all (summary maps to a field and none was given)
    res = await post({ kind: 'Software' });
    expect(res.status).toBe(400);

    // a NUL character is refused by the global request guard (it cannot be stored); other control characters are stripped
    res = await post({ subject: 'x\u0000y', kind: 'Software' });
    expect(res.status).toBe(400);

    // fully mapped submission; agentNote/triage are supplied by the customer but must be ignored
    res = await post({
      subject: 'Order  headset\u0007', kind: 'Hardware', serial: 'SN-123', urgency: 'High', tags: ['network'], due: '2026-05-06',
      dept: 'Finance', contact: 'bob@example.com', agentNote: 'customer injected', triage: 't1', evil: 'x',
    }, { description: 'Please hurry' });
    expect(res.status).toBe(201);
    const { key } = await res.json();

    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    expect(issue.summary).toBe('Order headset');
    expect(issue.priorityId).toBe(highId);
    expect(issue.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-06');
    const bobRow = (await db.select().from(schema.users).where(eq(schema.users.username, 'bob')))[0];
    expect(issue.assigneeId).toBe(bobRow.id);
    expect(issue.description).toContain('Please hurry');
    expect(issue.description).toContain('*Serial number*: SN-123');
    expect(issue.description).not.toContain('customer injected');
    expect(issue.description).not.toContain('t1');

    const labelRows = await db.select({ name: schema.labels.name }).from(schema.issueLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, issue.id));
    expect(labelRows.map((l) => l.name).sort()).toEqual(['network', 't2']); // t2 = internal default, never the customer's t1
    const [cfv] = await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.issueId, issue.id));
    expect(cfv.customFieldId).toBe(cfId);
    expect(cfv.stringValue).toBe('Finance');

    const [req] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id));
    expect(req.fieldValues).toMatchObject({ subject: 'Order  headset', serial: 'SN-123', triage: 't2' });
    expect(JSON.stringify(req.fieldValues)).not.toContain('customer injected');

    // customer's own request view does not echo internal values either
    const view = await (await call(alice, 'GET', `${SD}/portal/help-desk/request/${key}`)).text();
    expect(view).not.toContain('customer injected');
  });

  test('user picker only resolves people known to the desk; assignee must be an agent', async () => {
    const post = (contact: string) => call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: rtId, fieldValues: { subject: 'Who', kind: 'Software', contact } });
    let res = await post('carol@example.com'); // exists, but not part of this desk
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages[0]).toContain('known to this help center');
    res = await post('nobody@example.com');
    expect(res.status).toBe(400);
    res = await post('alice@example.com'); // a customer: accepted as a value, but never becomes assignee
    expect(res.status).toBe(201);
    const db = createTestDb(testSql);
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, (await res.json()).key));
    expect(issue.assigneeId).toBeNull();
  });

  test('legacy request types (no new properties) still work end to end', async () => {
    let res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, {
      name: 'Legacy', issueTypeId: seeded.issueType.id,
      fields: [{ key: 'device', label: 'Device', type: 'select', required: true, options: ['Laptop', 'Phone'] }, { key: 'urgent', label: 'Urgent', type: 'checkbox' }],
    });
    expect(res.status).toBe(201);
    const legacyId = (await res.json()).id;
    res = await call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: legacyId, summary: 'Old style', fieldValues: { device: 'Phone', urgent: true } });
    expect(res.status).toBe(201);
    const key = (await res.json()).key;
    const db = createTestDb(testSql);
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    expect(issue.summary).toBe('Old style');
    expect(issue.description).toContain('*Device*: Phone');
    expect(issue.description).toContain('*Urgent*: Yes');
    // summary stays mandatory when nothing maps to it
    res = await call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: legacyId, fieldValues: { device: 'Phone' } });
    expect(res.status).toBe(400);
  });

  /* ---------------- request type lifecycle ---------------- */

  test('duplicate, reorder and delete rules', async () => {
    let res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype/${rtId}/duplicate`);
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy.name).toBe('Equipment request (copy)');
    expect(copy.enabled).toBe(false);
    expect(copy.fields).toEqual((await (await call(admin, 'GET', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`)).json()).fields);
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype/${rtId}/duplicate`);
    expect((await res.json()).name).toBe('Equipment request (copy 2)');

    // disabled copies are not offered in the portal
    const portal = await (await call(alice, 'GET', `${SD}/portal/help-desk`)).json();
    expect(portal.requestTypes.map((t: any) => t.id)).not.toContain(copy.id);

    // reorder
    const list = (await (await call(admin, 'GET', `${SD}/servicedesk/${deskId}/requesttype`)).json()).values;
    const ids = list.map((t: any) => t.id).reverse();
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype/reorder`, { ids });
    expect(res.status).toBe(204);
    const after = (await (await call(admin, 'GET', `${SD}/servicedesk/${deskId}/requesttype`)).json()).values.map((t: any) => t.id);
    expect(after).toEqual(ids);
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype/reorder`, { ids: [999999] });
    expect(res.status).toBe(400);

    // delete refused when requests exist, allowed for the unused copy
    res = await call(admin, 'DELETE', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`);
    expect(res.status).toBe(409);
    expect((await res.json()).requestCount).toBeGreaterThan(0);
    res = await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`, { enabled: false });
    expect(res.status).toBe(200);
    res = await call(admin, 'DELETE', `${SD}/servicedesk/${deskId}/requesttype/${copy.id}`);
    expect(res.status).toBe(204);
  });

  test('organization-restricted request types are only offered to members of those organizations', async () => {
    // Earlier tests in this file already used alice's hourly portal request budget; start from a clean slate.
    for (const pattern of ['veqsio:ratelimit:*', 'veqsio:portal-limit:*']) for (const k of await redis.keys(pattern)) await redis.del(k);
    let res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/organization`, { name: 'Acme' });
    expect(res.status).toBe(201);
    const org = await res.json();
    expect((await call(admin, 'POST', `${SD}/servicedesk/${deskId}/organization`, { name: 'acme' })).status).toBe(409);

    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, {
      name: 'Acme only', issueTypeId: seeded.issueType.id, visibility: 'organizations', organizationIds: [org.id],
      fields: [{ key: 'q', label: 'Question', type: 'textarea' }],
    });
    expect(res.status).toBe(201);
    const acmeType = await res.json();
    expect(acmeType.organizationIds).toEqual([org.id]);
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/requesttype`, {
      name: 'Nobody', issueTypeId: seeded.issueType.id, visibility: 'organizations', organizationIds: [], fields: [],
    });
    expect(res.status).toBe(400);

    const ids = async (cookie: string) => (await (await call(cookie, 'GET', `${SD}/portal/help-desk`)).json()).requestTypes.map((t: any) => t.id);
    expect(await ids(alice)).not.toContain(acmeType.id);
    res = await call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: acmeType.id, summary: 's', fieldValues: {} });
    expect(res.status).toBe(400);

    // add alice to the organization (by email)
    res = await call(admin, 'POST', `${SD}/servicedesk/${deskId}/customer`, { email: 'alice@example.com', organizationId: org.id });
    expect(res.status).toBe(204);
    expect(await ids(alice)).toContain(acmeType.id);
    res = await call(alice, 'POST', `${SD}/portal/help-desk/request`, { requestTypeId: acmeType.id, summary: 's', fieldValues: {} });
    expect(res.status).toBe(201);
    res = await call(admin, 'GET', `${SD}/servicedesk/${deskId}/customer`);
    expect((await res.json()).values.find((c: any) => c.email === 'alice@example.com').organization).toBe('Acme');
    expect((await call(admin, 'POST', `${SD}/servicedesk/${deskId}/customer`, { email: 'ghost@example.com' })).status).toBe(404);

    // removing the organization detaches customers
    res = await call(admin, 'DELETE', `${SD}/servicedesk/${deskId}/organization/${org.id}`);
    expect(res.status).toBe(204);
    expect(await ids(alice)).not.toContain(acmeType.id);
  });

  test('portal settings: title, ordered groups, rename, validation', async () => {
    let res = await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/requesttype/${rtId}`, { groupName: 'Hardware', enabled: true });
    expect(res.status).toBe(200);
    res = await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, {
      portalTitle: 'Acme Help', introduction: 'Welcome', accentColor: '#112233', logoUrl: 'https://example.com/logo.png',
      groups: [{ name: 'Other' }, { name: 'Devices', renamedFrom: 'Hardware' }],
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.groups.map((g: any) => g.name)).toEqual(['Other', 'Devices']);
    expect(saved.groups[1].requestTypeCount).toBe(1);

    res = await call(alice, 'GET', `${SD}/portal/help-desk`);
    const portal = await res.json();
    expect(portal.portalTitle).toBe('Acme Help');
    expect(portal.groups).toEqual(['Other', 'Devices']);
    expect(portal.requestTypes.find((t: any) => t.id === rtId).groupName).toBe('Devices');

    expect((await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { logoUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { logoUrl: '//evil.example/x.png' })).status).toBe(400);
    expect((await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { accentColor: 'red' })).status).toBe(400);
    expect((await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { groups: [{ name: 'A' }, { name: 'a' }] })).status).toBe(400);
    expect((await call(admin, 'PUT', `${SD}/servicedesk/${deskId}/portal-settings`, { hacked: true })).status).toBe(400);
    // customers cannot read configuration
    expect((await call(alice, 'GET', `${SD}/servicedesk/${deskId}/portal-settings`)).status).toBe(404);
  });

  test('desk can be disabled; attaching to an existing project still works', async () => {
    let res = await call(admin, 'POST', `${SD}/servicedesk`, { projectKey: 'TEST', name: 'On Test', slug: 'on-test', template: 'facilities' });
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(d.projectKey).toBe('TEST');
    res = await call(admin, 'PUT', `${SD}/servicedesk/${d.id}`, { enabled: false });
    expect(res.status).toBe(200);
    expect((await call(alice, 'GET', `${SD}/portal/on-test`)).status).toBe(404);
  });
});
