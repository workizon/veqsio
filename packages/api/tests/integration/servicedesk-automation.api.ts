import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { and, eq } from 'drizzle-orm';
import app from '../../src/app';
import { runDeskAutomations, onCustomerReply, onRequestCreated } from '../../src/servicedesk/automation';

describe('Service desk automation rules', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin = '', alice = '', stranger = '';
  let deskId = 0;
  let aliceId = 0;
  const base = () => `/rest/servicedeskapi/servicedesk/${deskId}/automation`;
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
  const comments = async (issueId: number) => (await db.select().from(schema.comments).where(eq(schema.comments.issueId, issueId))).map((c) => c.body);
  let n = 0;
  const mkRequest = async (extra: Partial<typeof schema.issues.$inferInsert> = {}) => {
    const [iss] = await db.insert(schema.issues).values({
      issueKey: `TEST-A${++n}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id,
      summary: `Auto ${n}`, reporterId: aliceId, ...extra,
    }).returning();
    await db.insert(schema.serviceRequests).values({ issueId: iss.id, serviceDeskId: deskId, customerId: aliceId, channel: 'portal' });
    return iss;
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [a] = await db.insert(schema.users).values({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash }).returning();
    aliceId = a.id;
    await db.insert(schema.users).values({ username: 'stranger', email: 'stranger@example.com', displayName: 'Stranger', passwordHash: hash });
    admin = await login('admin'); alice = await login('alice'); stranger = await login('stranger');
    deskId = (await (await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Auto', slug: 'auto-desk', template: 'it-support' })).json()).id;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('rule management needs a desk administrator; customers and outsiders see nothing', async () => {
    const rule = { name: 'Close stale', trigger: 'waiting_days', threshold: 7, action: 'comment', params: { text: 'Closed after {{days}} days' } };
    expect((await app.request(base(), { method: 'GET' })).status).toBe(401);
    expect((await call(stranger, 'GET', base())).status).toBe(404);
    expect((await call(alice, 'POST', base(), rule)).status).toBe(404); // a customer is not staff
    const created = await call(admin, 'POST', base(), rule);
    expect(created.status).toBe(201);
    const id = (await created.json()).id;
    expect((await (await call(admin, 'GET', base())).json()).values.map((r: any) => r.id)).toContain(id);
    expect((await call(admin, 'PUT', `${base()}/${id}`, { ...rule, threshold: 3 })).status).toBe(200);
    expect((await call(admin, 'DELETE', `${base()}/${id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `${base()}/${id}`)).status).toBe(404);
  });

  test('rejects invalid combinations and references', async () => {
    const post = (b: object) => call(admin, 'POST', base(), { name: 'x', params: {}, ...b });
    expect((await post({ trigger: 'sla_percent', threshold: 150, action: 'notify' })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'reassign' })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'reassign', params: { userId: 99999 } })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'priority', params: { priorityId: 99999 } })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'notify', params: { slaId: 99999 } })).status).toBe(400);
    expect((await post({ trigger: 'nope', action: 'notify' })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'notify', extra: 1 })).status).toBe(400);
  });

  test('waiting for the customer too long: the action runs once per request', async () => {
    const [waiting] = await db.insert(schema.statuses).values({ name: 'Waiting for customer', category: 'in_progress' }).returning();
    const stale = await mkRequest({ statusId: waiting.id });
    const fresh = await mkRequest({ statusId: waiting.id });
    const day = 86_400_000;
    await db.insert(schema.issueHistory).values([
      { issueId: stale.id, fieldName: 'status', oldValue: 'Open', newValue: 'Waiting for customer', authorId: seeded.user.id, createdAt: new Date(Date.now() - 9 * day) },
      { issueId: fresh.id, fieldName: 'status', oldValue: 'Open', newValue: 'Waiting for customer', authorId: seeded.user.id, createdAt: new Date(Date.now() - 2 * day) },
    ]);
    const rule = await (await call(admin, 'POST', base(), { name: 'Nudge', trigger: 'waiting_days', threshold: 7, action: 'comment', params: { text: 'No reply for {{days}} days on {{issue.key}}' } })).json();
    expect(await runDeskAutomations()).toBe(1);
    expect(await comments(stale.id)).toEqual([`No reply for 7 days on ${stale.issueKey}`]);
    expect(await comments(fresh.id)).toEqual([]);
    expect(await runDeskAutomations()).toBe(0); // the ledger prevents a second run
    expect(await comments(stale.id)).toHaveLength(1);
    const runs = await (await call(admin, 'GET', `${base()}/${rule.id}/runs`)).json();
    expect(runs.values[0]).toMatchObject({ issueKey: stale.issueKey, outcome: 'commented' });
    await db.delete(schema.sdAutomationRules).where(eq(schema.sdAutomationRules.id, rule.id));
  });

  test('a disabled rule does nothing; a failing action is recorded, not thrown', async () => {
    const [waiting] = await db.select().from(schema.statuses).where(eq(schema.statuses.name, 'Waiting for customer'));
    const iss = await mkRequest({ statusId: waiting.id });
    await db.insert(schema.issueHistory).values({ issueId: iss.id, fieldName: 'status', oldValue: 'Open', newValue: 'Waiting for customer', authorId: seeded.user.id, createdAt: new Date(Date.now() - 30 * 86_400_000) });
    const off = await (await call(admin, 'POST', base(), { name: 'Off', trigger: 'waiting_days', threshold: 1, action: 'comment', params: { text: 'x' }, enabled: false })).json();
    expect(await runDeskAutomations()).toBe(0);
    await call(admin, 'DELETE', `${base()}/${off.id}`);
    const bad = await (await call(admin, 'POST', base(), { name: 'Bad move', trigger: 'waiting_days', threshold: 1, action: 'transition', params: { status: 'Nonexistent status' } })).json();
    expect(await runDeskAutomations()).toBe(3); // every request that has waited more than a day, including the two from the previous test
    const [run] = await db.select().from(schema.sdAutomationRuns).where(and(eq(schema.sdAutomationRuns.ruleId, bad.id), eq(schema.sdAutomationRuns.issueId, iss.id)));
    expect(run.outcome).toContain('failed');
    await call(admin, 'DELETE', `${base()}/${bad.id}`);
  });

  test('a customer reply on a resolved request runs "customer replied" rules; unresolved requests are left alone', async () => {
    const [res] = await db.insert(schema.resolutions).values({ name: 'Fixed' }).onConflictDoNothing().returning();
    const resolution = res ?? (await db.select().from(schema.resolutions))[0];
    const resolved = await mkRequest({ resolutionId: resolution.id, resolvedAt: new Date() });
    const open = await mkRequest();
    const rule = await (await call(admin, 'POST', base(), { name: 'Welcome back', trigger: 'customer_reply', action: 'comment', params: { text: 'Thanks, we are looking at {{issue.key}} again' } })).json();
    expect(await onCustomerReply(open.id)).toBe(0);
    expect(await onCustomerReply(resolved.id)).toBe(1);
    expect(await comments(resolved.id)).toEqual([`Thanks, we are looking at ${resolved.issueKey} again`]);
    expect(await comments(open.id)).toEqual([]);
    await call(admin, 'DELETE', `${base()}/${rule.id}`);
  });

  test('new request rules categorise and prioritise by keyword, channel and request type', async () => {
    const [high] = await db.insert(schema.priorities).values({ name: 'Urgent', sortOrder: 0 }).returning();
    const [type] = await db.insert(schema.requestTypes).values({ serviceDeskId: deskId, name: 'Hardware', issueTypeId: seeded.issueType.id }).returning();
    const post = (b: object) => call(admin, 'POST', base(), { name: 'x', params: {}, ...b });
    expect((await post({ trigger: 'request_created', action: 'priority', params: { priorityId: high.id }, conditions: { contains: ['printer'] } })).status).toBe(201);
    expect((await post({ name: 'Label it', trigger: 'request_created', action: 'label', params: { labels: ['hardware', 'triaged'] }, conditions: { contains: ['printer', 'scanner'] } })).status).toBe(201);
    expect((await post({ name: 'Set type', trigger: 'request_created', action: 'request_type', params: { requestTypeId: type.id }, conditions: { contains: ['printer'] } })).status).toBe(201);
    // invalid combinations and foreign references
    expect((await post({ trigger: 'request_created', action: 'label', params: {} })).status).toBe(400);
    expect((await post({ trigger: 'sla_breached', action: 'label', params: { labels: ['x'] } })).status).toBe(400);
    expect((await post({ trigger: 'request_created', action: 'request_type', params: { requestTypeId: 99999 } })).status).toBe(400);
    expect((await post({ trigger: 'request_created', action: 'notify', conditions: { channel: 'fax' } })).status).toBe(400);

    const match = await mkRequest({ summary: 'The Printer on floor 3 is jammed' });
    const other = await mkRequest({ summary: 'Cannot log in to VPN' });
    expect(await onRequestCreated(match.id)).toBe(3);
    expect(await onRequestCreated(other.id)).toBe(0);
    const after = await (await call(admin, 'GET', `/rest/api/2/issue/${match.issueKey}`)).json();
    expect(after.fields.priority.id).toBe(high.id);
    expect(after.fields.labels.sort()).toEqual(['hardware', 'triaged']);
    const [req] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, match.id));
    expect(req.requestTypeId).toBe(type.id);
    const untouched = await (await call(admin, 'GET', `/rest/api/2/issue/${other.issueKey}`)).json();
    expect(untouched.fields.priority.id).toBe(seeded.priority.id);
    // each rule runs once per request
    expect(await onRequestCreated(match.id)).toBe(0);
  });
});
