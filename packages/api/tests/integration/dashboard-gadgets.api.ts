import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

/**
 * Average Age / Resolution Time gadgets must only aggregate issues from projects
 * the caller may browse (BROWSE_PROJECTS), never from the whole instance.
 */
describe('Dashboard gadgets are scoped to browsable projects', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, carol: string, dave: string;
  const hour = 3_600_000;

  const get = (cookie: string, url: string) => app.request(url, { headers: { Cookie: cookie } });
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [carolUser, daveUser] = await db.insert(schema.users).values([
      { username: 'carol', email: 'carol@example.com', displayName: 'Carol', passwordHash: hash },
      { username: 'dave', email: 'dave@example.com', displayName: 'Dave', passwordHash: hash },
    ]).returning();

    // Project A (seeded TEST): carol may browse it. Project B: secret scheme, nobody but admin.
    await db.insert(schema.permissionEntries).values([
      { schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: carolUser.id },
      { schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: daveUser.id },
    ]);
    const [projectB] = await db.insert(schema.projects).values({ projectKey: 'SECRET', name: 'Secret', leadId: seeded.user.id }).returning();
    const [schemeB] = await db.insert(schema.permissionSchemes).values({ name: 'Secret scheme' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: projectB.id, schemeId: schemeB.id });

    const now = Date.now();
    const mk = (n: number, projectId: number, resolved: boolean) => ({
      issueKey: `${projectId === projectB.id ? 'SECRET' : 'TEST'}-${n}`, projectId,
      issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: `i${n}`, reporterId: seeded.user.id,
      createdAt: new Date(now - 48 * hour), resolvedAt: resolved ? new Date(now - 1 * hour) : null,
    });
    // A: 1 resolved + 1 open. B: 2 resolved + 2 open.
    await db.insert(schema.issues).values([
      mk(1, seeded.project.id, true), mk(2, seeded.project.id, false),
      mk(1, projectB.id, true), mk(2, projectB.id, true), mk(3, projectB.id, false), mk(4, projectB.id, false),
    ]);

    admin = await login('admin');
    carol = await login('carol');
    // dave's scheme entry is removed below to check the "no browsable project" case
    await db.delete(schema.permissionEntries).where(eq(schema.permissionEntries.userId, daveUser.id));
    await db.insert(schema.permissionEntries).values({ schemeId: schemeB.id, permissionKey: 'BROWSE_PROJECTS', userId: daveUser.id });
    dave = await login('dave');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  const last = (body: any) => body.data[body.data.length - 1];

  test('administrator sees every project', async () => {
    let res = await get(admin, '/rest/api/2/dashboard/gadgets/resolution-time?period=weekly&count=1');
    expect(res.status).toBe(200);
    expect(last(await res.json()).resolvedCount).toBe(3);

    res = await get(admin, '/rest/api/2/dashboard/gadgets/average-age?period=weekly&count=1');
    expect(last(await res.json()).openCount).toBe(3);
  });

  test('user who can browse only project A sees only project A', async () => {
    let res = await get(carol, '/rest/api/2/dashboard/gadgets/resolution-time?period=weekly&count=1');
    expect(res.status).toBe(200);
    const rt = last(await res.json());
    expect(rt.resolvedCount).toBe(1);
    expect(rt.averageDays).toBeCloseTo(47 / 24, 1);

    res = await get(carol, '/rest/api/2/dashboard/gadgets/average-age?period=weekly&count=1');
    expect(last(await res.json()).openCount).toBe(1);
  });

  test('user who can browse only the secret project sees only that project', async () => {
    let res = await get(dave, '/rest/api/2/dashboard/gadgets/resolution-time?period=weekly&count=1');
    expect(res.status).toBe(200);
    expect(last(await res.json()).resolvedCount).toBe(2);

    res = await get(dave, '/rest/api/2/dashboard/gadgets/average-age?period=weekly&count=1');
    expect(last(await res.json()).openCount).toBe(2);
  });

  test('anonymous requests are rejected', async () => {
    const res = await app.request('/rest/api/2/dashboard/gadgets/average-age');
    expect([401, 403]).toContain(res.status);
  });
  test('saving a dashboard persists gadgets, titles and positions; only the owner may save', async () => {
    const send = (cookie: string, method: string, url: string, body?: unknown) =>
      app.request(url, {
        method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    let res = await send(admin, 'POST', '/rest/api/2/dashboard', { name: 'Ops' });
    expect(res.status).toBeLessThan(300);
    const dashId = (await res.json()).id;

    res = await send(admin, 'PUT', `/rest/api/2/dashboard/${dashId}`, {
      gadgets: [
        { type: 'average-age', title: 'Age', config: { period: 'weekly', count: 8 }, position: { column: 0, row: 0 } },
        { type: 'pie-chart', title: 'By status', config: {}, position: { column: 1, row: 0 } },
      ],
    });
    expect(res.status).toBe(200);

    res = await send(admin, 'GET', `/rest/api/2/dashboard/${dashId}`);
    const dash = await res.json();
    expect(dash.gadgets.map((g: any) => [g.type, g.title, g.position.column])).toEqual([
      ['average-age', 'Age', 0],
      ['pie-chart', 'By status', 1],
    ]);
    expect(dash.gadgets[0].config.period).toBe('weekly');

    // Saving again replaces the set instead of appending.
    await send(admin, 'PUT', `/rest/api/2/dashboard/${dashId}`, { gadgets: [{ type: 'pie-chart', title: 'Only', config: {} }] });
    expect((await (await send(admin, 'GET', `/rest/api/2/dashboard/${dashId}`)).json()).gadgets).toHaveLength(1);

    // Invalid payloads are rejected and leave the saved state untouched.
    expect((await send(admin, 'PUT', `/rest/api/2/dashboard/${dashId}`, { gadgets: [{ title: 'no type' }] })).status).toBe(400);
    expect((await (await send(admin, 'GET', `/rest/api/2/dashboard/${dashId}`)).json()).gadgets).toHaveLength(1);

    // Another user cannot overwrite it.
    expect((await send(carol, 'PUT', `/rest/api/2/dashboard/${dashId}`, { gadgets: [] })).status).toBe(403);
  });
});
