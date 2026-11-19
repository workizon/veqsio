import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { applyTemplate } from '../../src/servicedesk/templates';
import { renderCanned } from '../../src/routes/servicedesk-canned';

describe('Service Desk template and canned responses', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let tdb: ReturnType<typeof createTestDb>;
  let admin: string, agent: string, alice: string, stranger: string;
  let deskId: number, otherDeskId: number;
  let requestKey: string;
  let cannedId: number;

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
    tdb = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await tdb.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const users = await tdb.insert(schema.users).values([
      { username: 'agent1', email: 'agent1@example.com', displayName: 'Agent One', passwordHash: hash },
      { username: 'alice', email: 'alice@example.com', displayName: 'Alice Customer', passwordHash: hash },
      { username: 'stranger', email: 'stranger@example.com', displayName: 'Stranger', passwordHash: hash },
    ]).returning();
    await tdb.insert(schema.projects).values({ projectKey: 'OTH', name: 'Other', leadId: seeded.user.id });
    admin = await login('admin');
    agent = await login('agent1');
    alice = await login('alice');
    stranger = await login('stranger');
    (globalThis as any).__tplUsers = users;
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('creating a desk without template keeps the single default queue', async () => {
    const res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'OTH', name: 'Plain', slug: 'plain' });
    expect(res.status).toBe(201);
    otherDeskId = (await res.json()).id;
    const q = await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${otherDeskId}/queue`)).json();
    expect(q.values).toHaveLength(1);
    const rt = await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${otherDeskId}/requesttype`)).json();
    expect(rt.values).toHaveLength(0);
  });

  test('rejects unknown template and unknown keys', async () => {
    let res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'x', slug: 'bad-one', template: 'nope' });
    expect(res.status).toBe(400);
    res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'x', slug: 'bad-one', template: 'none', extra: 1 });
    expect(res.status).toBe(400);
  });

  test('it-support template creates request types, queues and SLAs', async () => {
    const res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', {
      projectKey: 'TEST', name: 'IT', slug: 'it', publicSignup: true, template: 'it-support',
    });
    expect(res.status).toBe(201);
    deskId = (await res.json()).id;

    const rt = (await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`)).json()).values;
    expect(rt.map((r: any) => r.name)).toEqual(['Get IT help', 'Report a problem', 'Request new software']);
    expect(rt.every((r: any) => r.issueTypeId === seeded.issueType.id && r.fields.length > 0)).toBe(true);

    const queues = (await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/queue`)).json()).values;
    expect(queues.map((q: any) => q.name)).toEqual(['All open requests', 'Unassigned', 'My open requests']);

    const slas = (await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/sla`)).json()).values;
    expect(slas.map((s: any) => s.name)).toEqual(['Time to first response', 'Time to resolution']);
    expect(slas.every((s: any) => s.calendar === 'business')).toBe(true);
    expect(slas[0].goals[0].targetMinutes).toBe(240);
    expect(slas[1].goals[0].targetMinutes).toBe(1440);

    const [waiting] = await tdb.select().from(schema.statuses).where(eq(schema.statuses.name, 'Waiting for customer'));
    expect(waiting.category).toBe('in_progress');
    expect(slas[1].pauseStatusIds).toEqual([waiting.id]);
  });

  test('applyTemplate is idempotent', async () => {
    await applyTemplate(deskId, seeded.project.id, 'it-support');
    await applyTemplate(deskId, seeded.project.id, 'it-support');
    const counts = async () => ({
      rt: (await tdb.select().from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, deskId))).length,
      q: (await tdb.select().from(schema.serviceQueues).where(eq(schema.serviceQueues.serviceDeskId, deskId))).length,
      s: (await tdb.select().from(schema.slaDefinitions).where(eq(schema.slaDefinitions.serviceDeskId, deskId))).length,
      st: (await tdb.select().from(schema.statuses).where(eq(schema.statuses.name, 'Waiting for customer'))).length,
    });
    expect(await counts()).toEqual({ rt: 3, q: 3, s: 2, st: 1 });
  });

  test('applyTemplate rolls back on failure and rejects unknown desks', async () => {
    await expect(applyTemplate(987654, seeded.project.id, 'it-support')).rejects.toThrow();
    const names = await tdb.select().from(schema.issueTypes);
    expect(names.filter((n) => n.name === 'Service Request')).toHaveLength(0);
  });

  test('queues filter requests (unassigned / my open)', async () => {
    let res = await call(alice, 'GET', '/rest/servicedeskapi/portal/it');
    const portal = await res.json();
    res = await call(alice, 'POST', '/rest/servicedeskapi/portal/it/request', {
      requestTypeId: portal.requestTypes[0].id, summary: 'Printer', fieldValues: { details: 'jam' },
    });
    expect(res.status).toBe(201);
    requestKey = (await res.json()).key;

    const queues = (await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/queue`)).json()).values;
    const list = async (name: string) => {
      const q = queues.find((x: any) => x.name === name);
      return (await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/request?queue=${q.id}`)).json()).values;
    };
    expect(await list('Unassigned')).toHaveLength(1);
    expect(await list('My open requests')).toHaveLength(0);
    await tdb.update(schema.issues).set({ assigneeId: seeded.user.id }).where(eq(schema.issues.issueKey, requestKey));
    expect(await list('Unassigned')).toHaveLength(0);
    expect(await list('My open requests')).toHaveLength(1);
  });

  test('renderCanned replaces known placeholders only', () => {
    const out = renderCanned('Hi {{customer.name}} ({{ issue.key }}) {{foo.bar}} {{constructor}}', { 'customer.name': 'Al $& X', 'issue.key': 'K-1' });
    expect(out).toBe('Hi Al $& X (K-1) {{foo.bar}} {{constructor}}');
  });

  test('canned responses: admin writes, agent reads, others get 404', async () => {
    const users = (globalThis as any).__tplUsers as any[];
    const agentUser = users.find((u) => u.username === 'agent1');
    await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/agent`, { userId: agentUser.id, role: 'agent' });

    const base = `/rest/servicedeskapi/servicedesk/${deskId}/canned`;
    let res = await call(admin, 'POST', base, { title: 'Greeting', body: 'Hello {{customer.name}}, re {{issue.key}}. {{unknown}}' });
    expect(res.status).toBe(201);
    cannedId = (await res.json()).id;

    expect((await call(admin, 'POST', base, { title: 'x', body: 'y', serviceDeskId: 5 })).status).toBe(400);
    expect((await call(admin, 'POST', base, { title: '', body: 'y' })).status).toBe(400);
    expect((await call(admin, 'POST', base, { title: 'x', body: 'y'.repeat(10_001) })).status).toBe(400);

    // agent: read yes, write 403
    res = await call(agent, 'GET', base);
    expect(res.status).toBe(200);
    expect((await res.json()).values).toHaveLength(1);
    expect((await call(agent, 'POST', base, { title: 'a', body: 'b' })).status).toBe(403);
    expect((await call(agent, 'PUT', `${base}/${cannedId}`, { title: 'a' })).status).toBe(403);
    expect((await call(agent, 'DELETE', `${base}/${cannedId}`)).status).toBe(403);

    // customer and stranger: 404; anonymous: 401
    expect((await call(alice, 'GET', base)).status).toBe(404);
    expect((await call(stranger, 'GET', base)).status).toBe(404);
    expect((await app.request(base)).status).toBe(401);

    // render
    res = await call(agent, 'GET', `${base}/${cannedId}/render?issue=${requestKey}`);
    expect(res.status).toBe(200);
    expect((await res.json()).body).toBe(`Hello Alice Customer, re ${requestKey}. {{unknown}}`);
    expect((await call(agent, 'GET', `${base}/${cannedId}/render`)).status).toBe(400);
    expect((await call(agent, 'GET', `${base}/${cannedId}/render?issue=NOPE-1`)).status).toBe(404);
    expect((await call(alice, 'GET', `${base}/${cannedId}/render?issue=${requestKey}`)).status).toBe(404);
  });

  test('no cross-desk leakage', async () => {
    // Desk B (admin) cannot see or touch desk A canned responses through its own id
    const baseB = `/rest/servicedeskapi/servicedesk/${otherDeskId}/canned`;
    expect((await (await call(admin, 'GET', baseB)).json()).values).toHaveLength(0);
    expect((await call(admin, 'PUT', `${baseB}/${cannedId}`, { title: 'hijack' })).status).toBe(404);
    expect((await call(admin, 'DELETE', `${baseB}/${cannedId}`)).status).toBe(404);
    // A request of desk A cannot be rendered via desk B
    const resB = await call(admin, 'POST', baseB, { title: 'B', body: '{{issue.key}}' });
    const bId = (await resB.json()).id;
    expect((await call(admin, 'GET', `${baseB}/${bId}/render?issue=${requestKey}`)).status).toBe(404);
    expect((await call(admin, 'GET', `${baseB}/${cannedId}/render?issue=${requestKey}`)).status).toBe(404);
  });

  test('update and delete', async () => {
    const base = `/rest/servicedeskapi/servicedesk/${deskId}/canned`;
    let res = await call(admin, 'PUT', `${base}/${cannedId}`, { title: 'Hi', sortOrder: 2 });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Hi');
    expect((await call(admin, 'PUT', `${base}/${cannedId}`, {})).status).toBe(400);
    expect((await call(admin, 'DELETE', `${base}/${cannedId}`)).status).toBe(204);
    expect((await call(admin, 'DELETE', `${base}/${cannedId}`)).status).toBe(404);
  });
});
