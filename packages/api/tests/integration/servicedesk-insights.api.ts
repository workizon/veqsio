import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Service desk knowledge base and automation reports', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin = '', alice = '', stranger = '';
  let deskId = 0;
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
  const desk = (p: string) => `/rest/servicedeskapi/servicedesk/${deskId}${p}`;
  const portal = (p: string) => `/rest/servicedeskapi/portal/ins-desk${p}`;

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [a] = await db.insert(schema.users).values({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash }).returning();
    await db.insert(schema.users).values({ username: 'stranger', email: 'stranger@example.com', displayName: 'Stranger', passwordHash: hash });
    admin = await login('admin'); alice = await login('alice'); stranger = await login('stranger');
    deskId = (await (await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Insights', slug: 'ins-desk', template: 'it-support' })).json()).id;
    await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: deskId, userId: a.id });
    await db.insert(schema.kbArticles).values([
      { serviceDeskId: deskId, title: 'Reset your password', body: 'Use the forgot password link', published: true, views: 0 },
      { serviceDeskId: deskId, title: 'VPN setup', body: 'Install the client', published: true, views: 0 },
      { serviceDeskId: deskId, title: '=cmd|evil', body: 'x', published: false },
    ]);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('portal searches are logged, views and votes counted', async () => {
    const found = await (await call(alice, 'GET', portal('/kb?q=password'))).json();
    expect(found.values.length).toBe(1);
    await call(alice, 'GET', portal('/kb?q=printer'));
    await call(alice, 'GET', portal('/kb?q=printer'));
    await call(alice, 'GET', portal('/kb?q=x')); // too short to log
    await new Promise((r) => setTimeout(r, 200));
    const id = found.values[0].id;
    expect((await call(alice, 'GET', portal(`/kb/${id}`))).status).toBe(200);
    expect((await call(alice, 'POST', portal(`/kb/${id}/helpful`))).status).toBe(204);
    expect((await call(alice, 'POST', portal(`/kb/${id}/not-helpful`))).status).toBe(204);
    expect((await call(alice, 'POST', portal('/kb/99999/not-helpful'))).status).toBe(404);
  });

  test('the report is for staff and shows usage, gaps and a safe CSV', async () => {
    expect((await app.request(desk('/kb-report'))).status).toBe(401);
    expect((await call(stranger, 'GET', desk('/kb-report'))).status).toBe(404);
    expect((await call(alice, 'GET', desk('/kb-report'))).status).toBe(404); // a customer
    const r = await (await call(admin, 'GET', desk('/kb-report?days=30'))).json();
    expect(r.totals).toMatchObject({ articles: 3, published: 2, neverViewed: 1, searches: 3 });
    const pw = r.articles.find((a: any) => a.title === 'Reset your password');
    expect(pw).toMatchObject({ views: 1, helpful: 1, notHelpful: 1, helpfulPct: 50 });
    expect(r.top[0]).toMatchObject({ term: 'printer', searches: 2 });
    expect(r.gaps.map((g: any) => g.term)).toEqual(['printer']);
    const csv = await call(admin, 'GET', desk('/kb-report?format=csv'));
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('Reset your password');
    expect(text).toContain("'=cmd|evil"); // formula injection is neutralised
  });

  test('the automation report lists runs per rule', async () => {
    const rule = await (await call(admin, 'POST', desk('/automation'), { name: 'Report me', trigger: 'sla_breached', action: 'notify', params: {} })).json();
    const [iss] = await db.insert(schema.issues).values({ issueKey: 'TEST-I1', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'x', reporterId: seeded.user.id }).returning();
    await db.insert(schema.sdAutomationRuns).values({ ruleId: rule.id, issueId: iss.id, outcome: 'failed: no transition' });
    expect((await call(alice, 'GET', desk('/automation-report'))).status).toBe(404);
    const r = await (await call(admin, 'GET', desk('/automation-report'))).json();
    expect(r.values.find((v: any) => v.id === rule.id)).toMatchObject({ runs: 1, failures: 1, lastFailure: 'failed: no transition' });
    expect((await (await call(admin, 'GET', desk('/automation-report?format=csv'))).text())).toContain('Report me');
  });

  test('a whole question finds the right article, with a snippet, ranked by relevance', async () => {
    await db.insert(schema.kbArticles).values({ serviceDeskId: deskId, title: 'Connecting to the corporate network', body: `${'Intro text. '.repeat(30)}If the VPN client says certificate expired, install the new certificate from the portal and restart. ${'More text. '.repeat(30)}`, published: true });
    const res = await (await call(alice, 'GET', portal(`/kb?q=${encodeURIComponent('My VPN client says certificate expired, what now?')}`))).json();
    expect(res.values[0].title).toBe('Connecting to the corporate network');
    expect(res.values[0].excerpt).toContain('certificate expired');
    expect(res.values.map((v: any) => v.title)).toContain('VPN setup');
    expect((await (await call(alice, 'GET', portal(`/kb?q=${encodeURIComponent('zzzz qqqq')}`))).json()).values).toEqual([]);
    // unpublished articles never show up
    expect((await (await call(alice, 'GET', portal(`/kb?q=${encodeURIComponent('cmd evil')}`))).json()).values).toEqual([]);
  });
});
