import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Roadmap API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let admin: string;
  let viewer: string;
  let outsider: string;
  const ids: Record<string, number> = {};

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
    const [v, o] = await db.insert(schema.users).values([
      { username: 'viewer', email: 'v@x.test', displayName: 'Viewer', passwordHash: hash },
      { username: 'outsider', email: 'o@x.test', displayName: 'Outsider', passwordHash: hash },
    ]).returning();
    // Project scheme: only `viewer` may browse; nobody but admin may edit.
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'RM' }).returning();
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, seeded.project.id));
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: seeded.project.id, schemeId: scheme.id });
    await db.insert(schema.permissionEntries).values({ schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: v.id });

    await redis.del(`veqsio:ratelimit:user:${seeded.user.id}`, `veqsio:ratelimit:user:${v.id}`, `veqsio:ratelimit:user:${o.id}`, 'veqsio:ratelimit:ip:unknown');
    admin = await login('admin');
    viewer = await login('viewer');
    outsider = await login('outsider');

    const [epicType] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done' }).returning();
    const mkIssue = async (key: string, over: Partial<typeof schema.issues.$inferInsert>) => {
      const [i] = await db.insert(schema.issues).values({
        issueKey: key, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id,
        summary: key, reporterId: seeded.user.id, createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
      }).returning();
      ids[key] = i.id;
      return i;
    };
    await mkIssue('TEST-1', { issueTypeId: epicType.id, startDate: new Date('2026-02-01'), dueDate: new Date('2026-03-01') });
    await mkIssue('TEST-2', { issueTypeId: epicType.id });
    await mkIssue('TEST-3', { parentId: ids['TEST-1'], statusId: done.id, storyPoints: '3.00' });
    await mkIssue('TEST-4', { parentId: ids['TEST-1'], storyPoints: '5.00' });
    await mkIssue('TEST-5', {}); // orphan
    await db.insert(schema.issueHistory).values({
      issueId: ids['TEST-2'], fieldName: 'status', oldValue: 'To Do', newValue: 'In Progress', createdAt: new Date('2026-02-10T00:00:00Z'),
    });
    const [ver] = await db.insert(schema.versions).values([
      { projectId: seeded.project.id, name: '1.0', releaseDate: '2026-04-01' },
      { projectId: seeded.project.id, name: 'undated' },
    ]).returning();
    await db.insert(schema.issueFixVersions).values({ issueId: ids['TEST-2'], versionId: ver.id });
    const [blocks] = await db.insert(schema.linkTypes).values({ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }).returning();
    const [relates] = await db.insert(schema.linkTypes).values({ name: 'Relates', inward: 'relates to', outward: 'relates to' }).returning();
    await db.insert(schema.issueLinks).values([
      // TEST-2 "is blocked by" TEST-1 (issue_id shows the inward sentence; linked_issue_id is the blocker)
      { issueId: ids['TEST-2'], linkedIssueId: ids['TEST-1'], linkTypeId: blocks.id },
      { issueId: ids['TEST-1'], linkedIssueId: ids['TEST-2'], linkTypeId: relates.id },
    ]);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('returns epics with start/end sources, progress, versions and dependencies', async () => {
    const res = await req('GET', '/rest/agile/1.0/project/TEST/roadmap', admin);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.items.map((i: any) => i.key)).toEqual(['TEST-1', 'TEST-2']);
    const [e1, e2] = body.items;
    expect(e1).toMatchObject({
      startSource: 'explicit', endSource: 'due',
      progress: { children: { done: 1, total: 2 }, points: { done: 3, total: 8 }, percent: 38 },
    });
    expect(e1.start).toBe('2026-02-01T00:00:00.000Z');
    expect(e2).toMatchObject({ startSource: 'transition', start: '2026-02-10T00:00:00.000Z', endSource: 'version', end: '2026-04-01T00:00:00.000Z' });
    expect(body.versions.map((v: any) => v.name)).toEqual(['1.0']);
    expect(body.dependencies).toEqual([{ from: 'TEST-1', to: 'TEST-2', kind: 'blocks', conflict: false, message: null }]);
  });

  test('includeOrphans and window filtering', async () => {
    const withOrphans: any = await (await req('GET', '/rest/agile/1.0/project/TEST/roadmap?includeOrphans=true', admin)).json();
    expect(withOrphans.items.map((i: any) => i.key)).toContain('TEST-5');
    const windowed: any = await (await req('GET', '/rest/agile/1.0/project/TEST/roadmap?from=2026-03-15&to=2026-06-01', admin)).json();
    expect(windowed.items.map((i: any) => i.key)).toEqual(['TEST-2']);
    expect((await req('GET', '/rest/agile/1.0/project/TEST/roadmap?from=garbage', admin)).status).toBe(400);
    expect((await req('GET', '/rest/agile/1.0/project/TEST/roadmap?from=2026-06-01&to=2026-01-01', admin)).status).toBe(400);
  });

  test('requires BROWSE_PROJECTS (404 otherwise) and auth', async () => {
    expect((await req('GET', '/rest/agile/1.0/project/TEST/roadmap', viewer)).status).toBe(200);
    expect((await req('GET', '/rest/agile/1.0/project/TEST/roadmap', outsider)).status).toBe(404);
    expect((await req('GET', '/rest/agile/1.0/project/NOPE/roadmap', admin)).status).toBe(404);
    expect((await app.request('/rest/agile/1.0/project/TEST/roadmap')).status).toBe(401);
  });

  test('PUT dates reschedules, records history and validates', async () => {
    const put = (key: string, body: unknown, ck = admin) => req('PUT', `/rest/agile/1.0/roadmap/issue/${key}/dates`, ck, body);
    let res = await put('TEST-1', { startDate: '2026-02-05', dueDate: '2026-03-10' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: 'TEST-1', startDate: '2026-02-05', dueDate: '2026-03-10' });
    const [row] = await createTestDb(testSql).select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-1'));
    expect(row.startDate?.toISOString()).toBe('2026-02-05T00:00:00.000Z');
    expect(row.dueDate?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    const hist = await createTestDb(testSql).select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, ids['TEST-1']));
    expect(hist.map((h) => h.fieldName).sort()).toEqual(['duedate', 'startdate']);

    // Only moving the due date validates against the stored start date.
    expect((await put('TEST-1', { dueDate: '2026-02-01' })).status).toBe(400);
    expect((await put('TEST-1', { startDate: '2026-03-11' })).status).toBe(400);
    expect((await put('TEST-1', { startDate: '2026-03-12', dueDate: '2026-03-11' })).status).toBe(400);
    expect((await put('TEST-1', { startDate: '2026-02-30' })).status).toBe(400);
    expect((await put('TEST-1', {})).status).toBe(400);
    expect((await put('TEST-1', { startDate: '2026-02-05', extra: 1 })).status).toBe(400);
    expect((await put('TEST-1', { startDate: 20260205 })).status).toBe(400);
    // Clearing is allowed.
    res = await put('TEST-1', { startDate: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ startDate: null, dueDate: '2026-03-10' });
    expect((await put('TEST-404', { startDate: '2026-02-05' })).status).toBe(404);
  });

  test('PUT dates enforces permissions: no browse -> 404, browse only -> 403', async () => {
    const put = (ck: string) => req('PUT', '/rest/agile/1.0/roadmap/issue/TEST-2/dates', ck, { dueDate: '2026-05-01' });
    expect((await put(outsider)).status).toBe(404);
    expect((await put(viewer)).status).toBe(403);
    expect((await app.request('/rest/agile/1.0/roadmap/issue/TEST-2/dates', { method: 'PUT', body: '{}' })).status).toBe(401);
  });
});
