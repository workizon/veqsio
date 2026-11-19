import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { checkSlaBreaches } from '../../src/servicedesk/breach';

describe('Service Desk API Integration', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, alice: string, bob: string;
  let deskId: number;
  let requestKey: string;

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
    ]);
    admin = await login('admin');
    alice = await login('alice');
    bob = await login('bob');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('admin creates a desk, request type and SLA', async () => {
    let res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', {
      projectKey: 'TEST', name: 'IT Help', slug: 'it-help', publicSignup: true,
    });
    expect(res.status).toBe(201);
    deskId = (await res.json()).id;

    res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`, {
      name: 'Get IT help', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id,
      fields: [
        { key: 'device', label: 'Device', type: 'select', required: true, options: ['Laptop', 'Phone'] },
        { key: 'urgent', label: 'Urgent', type: 'checkbox' },
      ],
    });
    expect(res.status).toBe(201);

    res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/sla`, {
      name: 'Time to first response', metric: 'first_response',
      goals: [{ priorityId: null, targetMinutes: 60 }],
    });
    expect(res.status).toBe(201);
  });

  test('rejects unknown keys (mass assignment) when creating a desk', async () => {
    const res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', {
      projectKey: 'TEST', name: 'x', slug: 'other-desk', enabled: false, id: 99,
    });
    expect(res.status).toBe(400);
  });

  test('non-members cannot see agent endpoints (404, not 403)', async () => {
    const res = await call(alice, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}`);
    expect(res.status).toBe(404);
  });

  test('anonymous is rejected', async () => {
    const res = await app.request('/rest/servicedeskapi/portal/it-help');
    expect(res.status).toBe(401);
  });

  test('customer sees portal catalog and creates a request', async () => {
    let res = await call(alice, 'GET', '/rest/servicedeskapi/portal/it-help');
    expect(res.status).toBe(200);
    const portal = await res.json();
    expect(portal.requestTypes).toHaveLength(1);

    const rtId = portal.requestTypes[0].id;
    res = await call(alice, 'POST', '/rest/servicedeskapi/portal/it-help/request', {
      requestTypeId: rtId, summary: 'Laptop will not boot', fieldValues: { device: 'Tablet' },
    });
    expect(res.status).toBe(400); // invalid select option

    res = await call(alice, 'POST', '/rest/servicedeskapi/portal/it-help/request', {
      requestTypeId: rtId, summary: 'Laptop will not boot', fieldValues: { device: 'Laptop', urgent: true, evil: 'dropped' },
    });
    expect(res.status).toBe(201);
    requestKey = (await res.json()).key;
    expect(requestKey).toMatch(/^TEST-\d+$/);
  });

  test("another customer cannot read or comment on someone else's request", async () => {
    let res = await call(bob, 'GET', `/rest/servicedeskapi/portal/it-help/request/${requestKey}`);
    expect(res.status).toBe(404);
    res = await call(bob, 'POST', `/rest/servicedeskapi/portal/it-help/request/${requestKey}/comment`, { body: 'hi' });
    expect(res.status).toBe(404);
    res = await call(bob, 'GET', '/rest/servicedeskapi/portal/it-help/request');
    expect((await res.json()).values).toHaveLength(0);
  });

  test('internal agent comments are hidden from customers', async () => {
    let res = await call(admin, 'POST', `/rest/api/2/issue/${requestKey}/comment`, { body: 'secret note', internal: true });
    expect(res.status).toBe(201);
    expect((await res.json()).internal).toBe(true);
    res = await call(admin, 'POST', `/rest/api/2/issue/${requestKey}/comment`, { body: 'We are on it' });
    expect(res.status).toBe(201);

    // Portal view: public only
    res = await call(alice, 'GET', `/rest/servicedeskapi/portal/it-help/request/${requestKey}`);
    const texts = (await res.json()).comments.map((c: any) => c.body);
    expect(texts).toContain('We are on it');
    expect(texts).not.toContain('secret note');

    // Generic API: customers are not project members, so they cannot read it at all
    res = await call(alice, 'GET', `/rest/api/2/issue/${requestKey}/comment`);
    expect([401, 403]).toContain(res.status);

    // Agents see everything, flagged
    res = await call(admin, 'GET', `/rest/api/2/issue/${requestKey}/comment`);
    const all = (await res.json()).comments;
    expect(all.find((c: any) => c.body === 'secret note').internal).toBe(true);
  });

  test('comment threading: replies are same-issue, internal-inherited and hidden from customers', async () => {
    const db = createTestDb(testSql);
    const mk = async (b: any) => { const r = await call(admin, 'POST', `/rest/api/2/issue/${requestKey}/comment`, b); return { r, j: await r.json() }; };
    const pub = await mk({ body: 'public root' });
    const note = await mk({ body: 'private root', internal: true });
    expect(pub.j.parentId).toBeNull();

    // Reply to a public comment
    const reply = await mk({ body: 'public reply', parentId: Number(pub.j.id) });
    expect(reply.r.status).toBe(201);
    expect(reply.j.parentId).toBe(pub.j.id);
    expect(reply.j.internal).toBe(false);

    // A reply to an internal note is forced internal even if the client says otherwise
    const sneaky = await mk({ body: 'reply to note', parentId: Number(note.j.id), internal: false });
    expect(sneaky.r.status).toBe(201);
    expect(sneaky.j.internal).toBe(true);

    // Invalid parents
    expect((await mk({ body: 'x', parentId: 'abc' })).r.status).toBe(400);
    expect((await mk({ body: 'x', parentId: 999999 })).r.status).toBe(400);
    const [other] = await db.insert(schema.issues).values({
      issueKey: 'TEST-901', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'other', reporterId: seeded.user.id,
    }).returning();
    const [foreign] = await db.insert(schema.comments).values({ issueId: other.id, body: 'elsewhere', authorId: seeded.user.id }).returning();
    expect((await mk({ body: 'x', parentId: foreign.id })).r.status).toBe(400);

    // GET exposes parentId to agents
    let res = await call(admin, 'GET', `/rest/api/2/issue/${requestKey}/comment`);
    const all = (await res.json()).comments;
    expect(all.find((c: any) => c.body === 'public reply').parentId).toBe(pub.j.id);

    // Customer (portal): sees public reply with parentId, not the internal thread
    res = await call(alice, 'GET', `/rest/servicedeskapi/portal/it-help/request/${requestKey}`);
    const portal = (await res.json()).comments;
    expect(portal.find((c: any) => c.body === 'public reply').parentId).toBe(Number(pub.j.id));
    expect(portal.map((c: any) => c.body)).not.toContain('reply to note');

    // Customer can reply to a public comment but not to an internal one (indistinguishable from missing)
    const base = `/rest/servicedeskapi/portal/it-help/request/${requestKey}/comment`;
    res = await call(alice, 'POST', base, { body: 'thanks', parentId: Number(pub.j.id) });
    expect(res.status).toBe(201);
    res = await call(alice, 'POST', base, { body: 'probe', parentId: Number(note.j.id) });
    expect(res.status).toBe(400);
    res = await call(alice, 'POST', base, { body: 'probe', parentId: foreign.id });
    expect(res.status).toBe(400);
    // This test is request-heavy: don't eat the shared per-user rate-limit budget of later test files.
    for (let uid = 1; uid <= 30; uid++) await redis.del(`veqsio:ratelimit:user:${uid}`);
  });

  test('internal comments are rejected on non-service issues and by non-agents', async () => {
    const db = createTestDb(testSql);
    const [plain] = await db.insert(schema.issues).values({
      issueKey: 'TEST-900', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'plain', reporterId: seeded.user.id,
    }).returning();
    const res = await call(admin, 'POST', `/rest/api/2/issue/${plain.issueKey}/comment`, { body: 'x', internal: true });
    expect(res.status).toBe(400);
    const empty = await call(admin, 'POST', `/rest/api/2/issue/${requestKey}/comment`, { body: '   ' });
    expect(empty.status).toBe(400);
  });

  test('request meta is only revealed to agents', async () => {
    let res = await call(admin, 'GET', `/rest/servicedeskapi/request/${requestKey}/meta`);
    expect(await res.json()).toMatchObject({ isRequest: true, staff: true, deskId });
    res = await call(alice, 'GET', `/rest/servicedeskapi/request/${requestKey}/meta`);
    expect(await res.json()).toEqual({ isRequest: false, staff: false });
  });

  test('agent list shows SLA with first response met', async () => {
    const res = await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/request`);
    expect(res.status).toBe(200);
    const row = (await res.json()).values.find((r: any) => r.key === requestKey);
    expect(row.sla).toHaveLength(1);
    expect(row.sla[0].status).toBe('met');
  });

  test('SLA breach is notified exactly once', async () => {
    let res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/sla`, {
      name: 'Time to resolution', metric: 'resolution', goals: [{ priorityId: null, targetMinutes: 60 }],
    });
    expect(res.status).toBe(201);
    const db = createTestDb(testSql);
    await db.update(schema.issues).set({ assigneeId: seeded.user.id, createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(schema.issues.issueKey, requestKey));

    expect(await checkSlaBreaches()).toBe(1);
    expect(await checkSlaBreaches()).toBe(0);
    const mails = await db.select().from(schema.emailQueue);
    const slaMails = mails.filter((m) => m.subject === `SLA Breached: ${requestKey}`);
    expect(slaMails).toHaveLength(1);
    // (comment notifications queued earlier in this file are not the SLA mail, so do not index mails[0])
    expect(slaMails[0].toAddress).toBe('admin@veqsio.local');
  });

  test('CSAT only after resolution, only by owner', async () => {
    let res = await call(alice, 'POST', `/rest/servicedeskapi/portal/it-help/request/${requestKey}/csat`, { rating: 5 });
    expect(res.status).toBe(409);

    const db = createTestDb(testSql);
    await db.update(schema.issues).set({ resolvedAt: new Date() }).where(eq(schema.issues.issueKey, requestKey));
    res = await call(alice, 'POST', `/rest/servicedeskapi/portal/it-help/request/${requestKey}/csat`, { rating: 5, comment: 'Great' });
    expect(res.status).toBe(204);
    res = await call(alice, 'POST', `/rest/servicedeskapi/portal/it-help/request/${requestKey}/csat`, { rating: 9 });
    expect(res.status).toBe(400);

    res = await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/report`);
    const report = await res.json();
    expect(report.total).toBe(1);
    expect(report.csat.average).toBe(5);
    expect(report.daily.length).toBe(30);
    expect(report.csatDistribution[4].count).toBe(1);
  });
});
