import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { invalidateFeatures, invalidateProjectFeatures } from '../../src/features';

describe('Project status updates', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let admin: string;
  let viewer: string;
  let editor: string;
  let outsider: string;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [v, e, o] = await db.insert(schema.users).values([
      { username: 'viewer', email: 'v@x.test', displayName: 'Viewer', passwordHash: hash },
      { username: 'editor', email: 'e@x.test', displayName: 'Editor', passwordHash: hash },
      { username: 'outsider', email: 'o@x.test', displayName: 'Outsider', passwordHash: hash },
    ]).returning();
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'SU' }).returning();
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, seeded.project.id));
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: seeded.project.id, schemeId: scheme.id });
    await db.insert(schema.permissionEntries).values([
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: v.id },
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: e.id },
      { schemeId: scheme.id, permissionKey: 'EDIT_ISSUES', userId: e.id },
    ]);
    await redis.del(...[seeded.user.id, v.id, e.id, o.id].map((id: number) => `veqsio:ratelimit:user:${id}`), 'veqsio:ratelimit:ip:unknown');
    admin = await login('admin'); viewer = await login('viewer'); editor = await login('editor'); outsider = await login('outsider');

    const [epic] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    await db.insert(schema.issues).values([
      { issueKey: 'TEST-1', projectId: seeded.project.id, issueTypeId: epic.id, statusId: seeded.status.id, summary: 'An epic', reporterId: seeded.user.id },
      { issueKey: 'TEST-2', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'A task', reporterId: seeded.user.id },
    ]);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const url = '/rest/api/2/project/TEST/status-updates';

  test('empty history, then posting by a member with EDIT_ISSUES and reading by anyone who can browse', async () => {
    const empty = await (await req('GET', url, viewer)).json() as any;
    expect(empty).toEqual({ updates: [], latest: null });

    const res = await req('POST', url, editor, { state: 'at_risk', body: 'Vendor is late' });
    expect(res.status).toBe(201);
    const first = await res.json() as any;
    expect(first).toMatchObject({ state: 'at_risk', stateLabel: 'At risk', body: 'Vendor is late', author: { displayName: 'Editor' } });
    expect(typeof first.created).toBe('string');
    expect((await req('POST', url, admin, { state: 'on_track' })).status).toBe(201);

    const list = await (await req('GET', url, viewer)).json() as any;
    expect(list.updates.map((u: any) => u.state)).toEqual(['on_track', 'at_risk']); // newest first
    expect(list.latest.state).toBe('on_track');
  });

  test('permissions: browse-only users cannot post (403), outsiders get 404, anonymous 401', async () => {
    expect((await req('POST', url, viewer, { state: 'on_track' })).status).toBe(403);
    expect((await req('POST', url, outsider, { state: 'on_track' })).status).toBe(404);
    expect((await req('GET', url, outsider)).status).toBe(404);
    expect((await req('GET', '/rest/api/2/project/NOPE/status-updates', admin)).status).toBe(404);
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  test('validates input strictly', async () => {
    expect((await req('POST', url, editor, { state: 'green' })).status).toBe(400);
    expect((await req('POST', url, editor, {})).status).toBe(400);
    expect((await req('POST', url, editor, { state: 'on_track', extra: 1 })).status).toBe(400);
    expect((await req('POST', url, editor, { state: 'on_track', body: 'x'.repeat(10001) })).status).toBe(400);
  });

  test('stores text verbatim and queues an escaped notice to the lead, not to the author', async () => {
    const db = createTestDb(testSql);
    await db.delete(schema.emailQueue);
    const res = await req('POST', url, editor, { state: 'off_track', body: '<b>late</b>' });
    expect(((await res.json()) as any).body).toBe('<b>late</b>');
    await new Promise((r) => setTimeout(r, 400));
    const mails = await db.select().from(schema.emailQueue);
    expect(mails.map((m) => m.toAddress)).toEqual(['admin@veqsio.local']);
    expect(mails[0].subject).toContain('Off track');
    expect(mails[0].htmlBody).not.toContain('<b>late</b>');
  });

  test('latest state of all browsable projects', async () => {
    const mine = await (await req('GET', '/rest/api/2/status-updates/latest', viewer)).json() as any;
    expect(mine.latest.TEST.state).toBe('off_track');
    expect(((await (await req('GET', '/rest/api/2/status-updates/latest', outsider)).json()) as any).latest).toEqual({});
  });

  test('epics: only epics accept updates; same permissions', async () => {
    const epicUrl = '/rest/api/2/issue/TEST-1/status-updates';
    expect((await req('POST', epicUrl, editor, { state: 'on_track', body: 'Epic fine' })).status).toBe(201);
    expect((await req('POST', '/rest/api/2/issue/TEST-2/status-updates', editor, { state: 'on_track' })).status).toBe(400);
    expect((await req('POST', epicUrl, viewer, { state: 'on_track' })).status).toBe(403);
    expect((await req('GET', epicUrl, outsider)).status).toBe(404);
    const list = await (await req('GET', epicUrl, viewer)).json() as any;
    expect(list.updates).toHaveLength(1);
    const proj = await (await req('GET', url, viewer)).json() as any;
    expect(proj.updates.every((u: any) => u.body !== 'Epic fine')).toBe(true);
  });

  test('respects the per-project and instance feature switch', async () => {
    expect((await req('PUT', '/rest/api/2/project/TEST/features', admin, { features: { updates: false } })).status).toBe(200);
    invalidateFeatures(); invalidateProjectFeatures();
    expect((await req('GET', url, admin)).status).toBe(404);
    expect((await req('POST', url, admin, { state: 'on_track' })).status).toBe(404);
    expect((await req('GET', '/rest/api/2/issue/TEST-1/status-updates', admin)).status).toBe(404);
    expect(((await (await req('GET', '/rest/api/2/status-updates/latest', admin)).json()) as any).latest).toEqual({});
    expect((await req('PUT', '/rest/api/2/project/TEST/features', admin, { features: { updates: true } })).status).toBe(200);
    invalidateFeatures(); invalidateProjectFeatures();
    expect((await req('GET', url, admin)).status).toBe(200);
    expect((await req('PUT', '/rest/api/2/admin/features/updates', admin, { enabled: false })).status).toBe(200);
    invalidateFeatures();
    expect((await req('GET', url, admin)).status).toBe(404);
    expect((await req('PUT', '/rest/api/2/admin/features/updates', admin, { enabled: true })).status).toBe(200);
    invalidateFeatures();
  });
});
