import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Service desk CSAT report and follow-up queue', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin = '', alice = '', stranger = '';
  let deskId = 0;
  const base = () => `/rest/servicedeskapi/servicedesk/${deskId}/csat`;
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
  let n = 0;
  const keys: string[] = [];

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
    deskId = (await (await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'CSAT', slug: 'csat-desk', template: 'it-support' })).json()).id;
    const [res] = await db.insert(schema.resolutions).values({ name: 'Done' }).onConflictDoNothing().returning();
    const resolution = res ?? (await db.select().from(schema.resolutions))[0];
    const mk = async (rating: number | null, comment: string | null, assigneeId: number | null) => {
      const [iss] = await db.insert(schema.issues).values({ issueKey: `TEST-C${++n}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: `Rated ${n}`, reporterId: a.id, assigneeId, resolutionId: resolution.id, resolvedAt: new Date() }).returning();
      await db.insert(schema.serviceRequests).values({ issueId: iss.id, serviceDeskId: deskId, customerId: a.id, channel: 'portal', csatRating: rating, csatComment: comment, csatAt: rating ? new Date() : null });
      keys.push(iss.issueKey);
    };
    await mk(5, 'great', seeded.user.id);
    await mk(4, null, seeded.user.id);
    await mk(1, 'still broken', seeded.user.id);
    await mk(2, null, null);
    await mk(null, null, seeded.user.id); // resolved, never rated
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('only desk staff can read the report', async () => {
    expect((await app.request(base())).status).toBe(401);
    expect((await call(stranger, 'GET', base())).status).toBe(404);
    expect((await call(alice, 'GET', base())).status).toBe(404); // a customer
    expect((await call(admin, 'GET', base())).status).toBe(200);
  });

  test('summary, distribution, groups and the follow-up queue', async () => {
    const r = await (await call(admin, 'GET', `${base()}?days=30`)).json();
    expect(r.summary).toMatchObject({ responses: 4, average: 3 });
    expect(r.summary.satisfiedPct).toBe(50);
    expect(r.summary.responseRatePct).toBe(80);
    expect(r.distribution.map((d: any) => d.count)).toEqual([1, 1, 0, 1, 1]);
    expect(r.trend.length).toBeGreaterThanOrEqual(5);
    expect(r.byAgent.map((g: any) => g.name)).toContain('Administrator');
    expect(r.byAgent.map((g: any) => g.name)).toContain('Unassigned');
    expect(r.followUps.map((f: any) => f.rating).sort()).toEqual([1, 2]);
    expect(r.followUps.find((f: any) => f.rating === 1)).toMatchObject({ comment: 'still broken', customer: 'Alice' });
  });

  test('marking a poor rating as handled removes it from the queue (staff only)', async () => {
    const q = (await (await call(admin, 'GET', base())).json()).followUps;
    const poor = q.find((f: any) => f.rating === 1);
    expect((await call(alice, 'POST', `${base()}/${poor.key}/handled`)).status).toBe(404);
    expect((await call(admin, 'POST', `${base()}/NOPE-1/handled`)).status).toBe(404);
    expect((await call(admin, 'POST', `${base()}/${poor.key}/handled`)).status).toBe(200);
    const after = (await (await call(admin, 'GET', base())).json()).followUps;
    expect(after.map((f: any) => f.rating)).toEqual([2]);
  });
});
