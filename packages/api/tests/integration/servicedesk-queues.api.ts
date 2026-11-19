import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

/** Service desk queues run the real JQL engine (scoped to the desk's project), validate JQL on save and expose counts. */
describe('Service desk queues (real JQL)', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let tdb: ReturnType<typeof createTestDb>;
  let admin: string, alice: string;
  let deskId: number;
  let otherProjectId: number;
  const base = () => `/rest/servicedeskapi/servicedesk/${deskId}`;

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const mkQueue = async (name: string, jql: string | null) => (await (await call(admin, 'POST', `${base()}/queue`, { name, jql })).json()).id as number;
  const list = async (qid: number, qs = '') => (await call(admin, 'GET', `${base()}/request?queue=${qid}${qs}`)).json() as Promise<any>;

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    tdb = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await tdb.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [a] = await tdb.insert(schema.users).values({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash }).returning();
    const [other] = await tdb.insert(schema.projects).values({ projectKey: 'OTHQ', name: 'Other', leadId: seeded.user.id }).returning();
    otherProjectId = other.id;
    admin = await login('admin');
    alice = await login('alice');
    const res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Queues', slug: 'queues-desk', template: 'it-support' });
    deskId = (await res.json()).id;

    // 120 requests: 60 unresolved+unassigned, 40 assigned to admin, 20 resolved. Plus 5 foreign issues in another project.
    const [res1] = await tdb.insert(schema.resolutions).values({ name: 'Done' }).onConflictDoNothing().returning();
    const resolution = res1 ?? (await tdb.select().from(schema.resolutions))[0];
    const mk = async (n: number, extra: (i: number) => Partial<typeof schema.issues.$inferInsert>, projectId = seeded.project.id, withReq = true) => {
      for (let i = 0; i < n; i++) {
        const [iss] = await tdb.insert(schema.issues).values({
          issueKey: `${projectId === seeded.project.id ? 'TEST' : 'OTHQ'}-Q${Math.random().toString(36).slice(2, 9)}`,
          projectId, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id,
          summary: `Q issue ${i}`, reporterId: a.id, createdAt: new Date(Date.now() - i * 60_000), ...extra(i),
        }).returning();
        if (withReq) await tdb.insert(schema.serviceRequests).values({ issueId: iss.id, serviceDeskId: deskId, customerId: a.id, channel: 'portal' });
      }
    };
    await mk(60, () => ({}));
    await mk(40, () => ({ assigneeId: seeded.user.id }));
    await mk(20, () => ({ resolutionId: resolution.id, resolvedAt: new Date() }));
    await mk(5, () => ({}), otherProjectId, false);
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('template queues are plain JQL and still work', async () => {
    const queues = (await (await call(admin, 'GET', `${base()}/queue`)).json()).values;
    const by = (n: string) => queues.find((q: any) => q.name === n).id;
    expect((await list(by('All open requests'), '&limit=1')).total).toBe(100);
    expect((await list(by('Unassigned'), '&limit=1')).total).toBe(60);
    expect((await list(by('My open requests'), '&limit=1')).total).toBe(40);
  });

  test('more than 50 issues: pagination with total, stable and without overlap', async () => {
    const q = await mkQueue('Everything open', 'resolution = Unresolved ORDER BY created DESC');
    const p1 = await list(q, '&limit=50&start=0');
    const p2 = await list(q, '&limit=50&start=50');
    const p3 = await list(q, '&limit=50&start=100');
    expect(p1.total).toBe(100);
    expect(p1.values).toHaveLength(50);
    expect(p2.values).toHaveLength(50);
    expect(p3.values).toHaveLength(0);
    const keys = new Set([...p1.values, ...p2.values].map((r: any) => r.key));
    expect(keys.size).toBe(100);
    const created = p1.values.map((r: any) => Date.parse(r.created));
    expect([...created].sort((x, y) => y - x)).toEqual(created);
  });

  test('ORDER BY from the JQL is the queue sort', async () => {
    const q = await mkQueue('Oldest first', 'resolution = Unresolved ORDER BY created ASC');
    const r = await list(q, '&limit=20');
    const created = r.values.map((x: any) => Date.parse(x.created));
    expect([...created].sort((x, y) => x - y)).toEqual(created);
  });

  test('currentUser() and relative dates evaluate per viewer; other projects never leak', async () => {
    const q = await mkQueue('Mine recent', 'assignee = currentUser() AND created >= -1d');
    expect((await list(q, '&limit=1')).total).toBe(40);
    // alice is not staff: the queue endpoints answer 404
    expect((await call(alice, 'GET', `${base()}/request?queue=${q}`)).status).toBe(404);
    // a queue that explicitly targets another project is still narrowed to the desk's project
    const leak = await mkQueue('Foreign', 'project = OTHQ OR project = TEST');
    const r = await list(leak, '&limit=200');
    expect(r.total).toBe(120);
    expect(r.values.every((v: any) => !v.key.startsWith('OTHQ'))).toBe(true);
    const onlyForeign = await mkQueue('Only foreign', 'project = OTHQ');
    expect((await list(onlyForeign)).total).toBe(0);
  });

  test('richer JQL than the three old fragments (priority, text)', async () => {
    const q = await mkQueue('Medium & text', 'priority = Medium AND summary ~ "issue 1" AND resolution = Unresolved');
    const r = await list(q, '&limit=200');
    expect(r.total).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(100);
  });

  test('invalid JQL is rejected with the parser message and position on create and edit', async () => {
    let res = await call(admin, 'POST', `${base()}/queue`, { name: 'Bad', jql: 'resolution = Unresolved AND AND' });
    expect(res.status).toBe(400);
    let body = await res.json();
    expect(body.errorMessages[0].length).toBeGreaterThan(0);
    expect(body.jqlError.message).toBe(body.errorMessages[0]);
    expect(typeof body.jqlError.position).toBe('number');
    res = await call(admin, 'POST', `${base()}/queue`, { name: 'Bad2', jql: 'nosuchfield = 1' });
    expect(res.status).toBe(400);

    const id = await mkQueue('Editable', 'resolution = Unresolved');
    res = await call(admin, 'PUT', `${base()}/queue/${id}`, { jql: 'status = ' });
    expect(res.status).toBe(400);
    body = await res.json();
    expect(body.errors.jql).toBeTruthy();
    // the stored queue is untouched
    const queues = (await (await call(admin, 'GET', `${base()}/queue`)).json()).values;
    expect(queues.find((q: any) => q.id === id).jql).toBe('resolution = Unresolved');
    // renaming without touching JQL and clearing the JQL are fine
    expect((await call(admin, 'PUT', `${base()}/queue/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await call(admin, 'PUT', `${base()}/queue/${id}`, { jql: null })).status).toBe(200);
  });

  test('counts per queue with ?counts=true', async () => {
    const res = await call(admin, 'GET', `${base()}/queue?counts=true`);
    const values = (await res.json()).values as any[];
    expect(values.find((q) => q.name === 'Unassigned').count).toBe(60);
    expect(values.find((q) => q.name === 'My open requests').count).toBe(40);
    // without the flag no counts are computed
    const plain = (await (await call(admin, 'GET', `${base()}/queue`)).json()).values as any[];
    expect(plain[0].count).toBeUndefined();
  });
});
