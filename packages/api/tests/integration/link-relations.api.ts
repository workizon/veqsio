import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Issue relations, dependencies and link types', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let admin: string;
  let viewer: string;
  let outsider: string;
  const ids: Record<string, number> = {};
  const types: Record<string, number> = {};

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  /** `a` shows the type's inward sentence ("is blocked by", "starts after"); `b` the outward one ("blocks", "starts before"). */
  const link = (cookie: string, type: string, a: string, b: string) =>
    req('POST', '/rest/api/2/issueLink', cookie, { type: { id: types[type] }, inwardIssue: { id: ids[a] }, outwardIssue: { id: ids[b] } });
  const linksOf = async (key: string) => (await (await req('GET', `/rest/api/2/issue/${key}`, admin)).json() as any).fields.issuelinks as any[];

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
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'LR' }).returning();
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, seeded.project.id));
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: seeded.project.id, schemeId: scheme.id });
    await db.insert(schema.permissionEntries).values({ schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: v.id });
    await redis.del(`veqsio:ratelimit:user:${seeded.user.id}`, `veqsio:ratelimit:user:${v.id}`, `veqsio:ratelimit:user:${o.id}`, 'veqsio:ratelimit:ip:unknown');
    admin = await login('admin');
    viewer = await login('viewer');
    outsider = await login('outsider');

    // Apply the link type seed of the migration (the test database is truncated before each suite).
    const sql = readFileSync(new URL('../../../db/drizzle/0018_relations_status_updates.sql', import.meta.url), 'utf8');
    const start = sql.indexOf('UPDATE "link_types"');
    const end = sql.indexOf('-- Exactly one default workflow');
    const seedSql = sql.slice(start, end).split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean);
    for (const run of [1, 2]) for (const stmt of seedSql) await testSql.unsafe(stmt); // twice: must be idempotent
    for (const t of await db.select().from(schema.linkTypes)) types[t.name] = t.id;

    const mk = async (key: string, over: Partial<typeof schema.issues.$inferInsert> = {}) => {
      const [i] = await db.insert(schema.issues).values({
        issueKey: key, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id,
        summary: key, reporterId: seeded.user.id, ...over,
      }).returning();
      ids[key] = i.id;
    };
    await mk('TEST-1', { startDate: new Date('2026-01-01'), dueDate: new Date('2026-03-01') });
    await mk('TEST-2', { startDate: new Date('2026-02-15'), dueDate: new Date('2026-04-01') });
    await mk('TEST-3', { startDate: new Date('2026-04-02'), dueDate: new Date('2026-05-01') });
    await mk('TEST-4');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('the migration seeds every relation and dependency type once, additively', async () => {
    const db = createTestDb(testSql);
    const rows = await db.select().from(schema.linkTypes);
    expect(rows.map((r) => r.name).sort()).toEqual(['Blocks', 'Cloners', 'Duplicate', 'Finishes before', 'Implements', 'Relates', 'Starts before']);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Blocks).toMatchObject({ inward: 'is blocked by', outward: 'blocks', isSystem: true, scheduling: null });
    expect(by.Duplicate).toMatchObject({ inward: 'is duplicated by', outward: 'duplicates' });
    expect(by.Implements).toMatchObject({ inward: 'is implemented by', outward: 'implements' });
    expect(by.Cloners).toMatchObject({ inward: 'is cloned by', outward: 'clones' });
    expect(by.Relates).toMatchObject({ inward: 'relates to', outward: 'relates to' });
    expect(by['Finishes before']).toMatchObject({ scheduling: 'finishes_before', inward: 'finishes after', outward: 'finishes before' });
    expect(by['Starts before']).toMatchObject({ scheduling: 'starts_before' });
    const list = await (await req('GET', '/rest/api/2/issueLinkType', viewer)).json() as any;
    expect(list.issueLinkTypes.find((t: any) => t.name === 'Starts before').scheduling).toBe('starts_before');
  });

  test('a link mirrors on both issues with the right sentence', async () => {
    expect((await link(admin, 'Implements', 'TEST-1', 'TEST-4')).status).toBe(201);
    const a = (await linksOf('TEST-1')).find((l) => l.type.name === 'Implements');
    expect(a.inwardIssue.key).toBe('TEST-4');
    expect(a.type.inward).toBe('is implemented by');
    const b = (await linksOf('TEST-4')).find((l) => l.type.name === 'Implements');
    expect(b.outwardIssue.key).toBe('TEST-1');
    expect(b.type.outward).toBe('implements');
  });

  test('rejects self links, duplicates (also reversed for symmetric types) and unknown types or issues', async () => {
    expect((await link(admin, 'Blocks', 'TEST-1', 'TEST-1')).status).toBe(400);
    expect((await link(admin, 'Implements', 'TEST-1', 'TEST-4')).status).toBe(409);
    expect((await link(admin, 'Relates', 'TEST-1', 'TEST-4')).status).toBe(201);
    expect((await link(admin, 'Relates', 'TEST-4', 'TEST-1')).status).toBe(409); // "relates to" reads the same both ways
    expect((await link(admin, 'Blocks', 'TEST-1', 'TEST-4')).status).toBe(201); // other type, same pair: fine
    const bad = await req('POST', '/rest/api/2/issueLink', admin, { type: { id: 999999 }, inwardIssue: { id: ids['TEST-1'] }, outwardIssue: { id: ids['TEST-2'] } });
    expect(bad.status).toBe(404);
    const noIssue = await req('POST', '/rest/api/2/issueLink', admin, { type: { id: types.Blocks }, inwardIssue: { id: 999999 }, outwardIssue: { id: ids['TEST-2'] } });
    expect(noIssue.status).toBe(404);
  });

  test('dependencies: one per pair, no cycles, conflicts flagged from the dates', async () => {
    // TEST-2 starts after TEST-1 finishes? TEST-1 ends 03-01 but TEST-2 starts 02-15: conflict.
    expect((await link(admin, 'Finishes before', 'TEST-2', 'TEST-1')).status).toBe(201); // TEST-1 finishes before TEST-2
    const onSucc = (await linksOf('TEST-2')).find((l) => l.type.name === 'Finishes before');
    expect(onSucc.inwardIssue.key).toBe('TEST-1');
    expect(onSucc.dependency).toMatchObject({ role: 'successor', conflict: true });
    const onPred = (await linksOf('TEST-1')).find((l) => l.type.name === 'Finishes before');
    expect(onPred.outwardIssue.key).toBe('TEST-2');
    expect(onPred.dependency).toMatchObject({ role: 'predecessor', conflict: true });

    // only one dependency per pair, in either direction and across the two types
    expect((await link(admin, 'Starts before', 'TEST-2', 'TEST-1')).status).toBe(409);
    expect((await link(admin, 'Finishes before', 'TEST-1', 'TEST-2')).status).toBe(409);

    // chain TEST-1 -> TEST-2 -> TEST-3 (no conflict: TEST-2 ends 04-01, TEST-3 starts 04-02)
    expect((await link(admin, 'Finishes before', 'TEST-3', 'TEST-2')).status).toBe(201);
    const ok = (await linksOf('TEST-3')).find((l) => l.type.name === 'Finishes before');
    expect(ok.dependency.conflict).toBe(false);
    // closing the loop TEST-3 -> TEST-1 is a cycle
    const cycle = await link(admin, 'Starts before', 'TEST-1', 'TEST-3');
    expect(cycle.status).toBe(400);
    expect(((await cycle.json()) as any).errorMessages[0]).toMatch(/cycle/);
    // an issue without dates never conflicts
    expect((await link(admin, 'Starts before', 'TEST-4', 'TEST-3')).status).toBe(201);
    expect((await linksOf('TEST-4')).find((l) => l.type.name === 'Starts before').dependency.conflict).toBe(false);
  });

  test('linking needs LINK_ISSUES, and hidden issues do not exist for the caller', async () => {
    expect((await link(viewer, 'Relates', 'TEST-2', 'TEST-3')).status).toBe(403);
    expect((await link(outsider, 'Relates', 'TEST-2', 'TEST-3')).status).toBe(404);
    expect((await app.request('/rest/api/2/issueLink', { method: 'POST' })).status).toBe(401);
    const l = (await linksOf('TEST-4')).find((x) => x.type.name === 'Implements');
    expect((await req('DELETE', `/rest/api/2/issueLink/${l.id}`, viewer)).status).toBe(403);
    expect((await req('DELETE', `/rest/api/2/issueLink/${l.id}`, outsider)).status).toBe(404);
    expect((await req('DELETE', `/rest/api/2/issueLink/${l.id}`, admin)).status).toBe(200);
    expect((await req('DELETE', `/rest/api/2/issueLink/${l.id}`, admin)).status).toBe(404);
    expect((await linksOf('TEST-4')).some((x) => x.type.name === 'Implements')).toBe(false);
  });

  test('the roadmap returns dependency arrows with conflict warnings', async () => {
    const db = createTestDb(testSql);
    const [epic] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    await db.update(schema.issues).set({ issueTypeId: epic.id }).where(eq(schema.issues.projectId, seeded.project.id));
    const body = await (await req('GET', '/rest/agile/1.0/project/TEST/roadmap', admin)).json() as any;
    const fin = body.dependencies.filter((d: any) => d.kind === 'finishes_before');
    expect(fin).toContainEqual(expect.objectContaining({ from: 'TEST-1', to: 'TEST-2', conflict: true }));
    expect(fin).toContainEqual(expect.objectContaining({ from: 'TEST-2', to: 'TEST-3', conflict: false }));
  });

  test('administrators define custom link types; built-in ones are protected', async () => {
    expect((await req('GET', '/rest/api/2/admin/linktype', viewer)).status).toBe(403);
    expect((await req('POST', '/rest/api/2/admin/linktype', viewer, { name: 'x', inward: 'a', outward: 'b' })).status).toBe(403);
    expect((await app.request('/rest/api/2/admin/linktype')).status).toBe(401);

    const created = await req('POST', '/rest/api/2/admin/linktype', admin, { name: 'Causes', inward: 'is caused by', outward: 'causes' });
    expect(created.status).toBe(201);
    const t = (await created.json()) as any;
    expect(t).toMatchObject({ name: 'Causes', isSystem: false, scheduling: null });
    expect((await req('POST', '/rest/api/2/admin/linktype', admin, { name: 'causes', inward: 'a', outward: 'b' })).status).toBe(409);
    expect((await req('POST', '/rest/api/2/admin/linktype', admin, { name: '', inward: 'a', outward: 'b' })).status).toBe(400);
    expect((await req('POST', '/rest/api/2/admin/linktype', admin, { name: 'Y', inward: 'a', outward: 'b', scheduling: 'starts_before' })).status).toBe(400); // strict

    // usable straight away and listed with usage counts
    types.Causes = Number(t.id);
    expect((await link(admin, 'Causes', 'TEST-3', 'TEST-4')).status).toBe(201);
    const list = await (await req('GET', '/rest/api/2/admin/linktype', admin)).json() as any;
    expect(list.issueLinkTypes.find((x: any) => x.name === 'Causes').linkCount).toBe(1);

    expect((await req('PUT', `/rest/api/2/admin/linktype/${t.id}`, admin, { outward: 'leads to' })).status).toBe(200);
    expect((await req('PUT', `/rest/api/2/admin/linktype/${types.Blocks}`, admin, { outward: 'stops' })).status).toBe(409);
    expect((await req('PUT', '/rest/api/2/admin/linktype/999999', admin, { outward: 'x' })).status).toBe(404);
    expect((await req('DELETE', `/rest/api/2/admin/linktype/${types.Blocks}`, admin)).status).toBe(409);
    const used = await req('DELETE', `/rest/api/2/admin/linktype/${t.id}`, admin);
    expect(used.status).toBe(409);
    expect(((await used.json()) as any).linkCount).toBe(1);
    const l = (await linksOf('TEST-4')).find((x) => x.type.name === 'Causes');
    await req('DELETE', `/rest/api/2/issueLink/${l.id}`, admin);
    expect((await req('DELETE', `/rest/api/2/admin/linktype/${t.id}`, admin)).status).toBe(200);
  });
});
