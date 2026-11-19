import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Role-based permission scheme template', () => {
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs an administrator and validates input', async () => {
    expect((await app.request('/rest/api/2/permissionscheme/templates/role-based', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await call('POST', '/rest/api/2/permissionscheme/templates/role-based', { name: '', extra: 1 })).status).toBe(400);
  });

  test('creates the scheme and the missing roles, adding nothing twice', async () => {
    const res = await call('POST', '/rest/api/2/permissionscheme/templates/role-based', { name: 'Strict' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rolesCreated).toContain('Commenters');
    const db = createTestDb(testSql);
    const entries = await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, Number(body.id)));
    const roles = await db.select().from(schema.projectRoles);
    const commenters = roles.find((r) => r.name === 'Commenters')!;
    const keys = entries.filter((e) => e.projectRoleId === commenters.id).map((e) => e.permissionKey);
    expect(keys).toContain('ADD_COMMENTS');
    expect(keys).not.toContain('EDIT_ISSUES');
    expect(entries.every((e) => e.groupId === null && !e.anyUser)).toBe(true);
    const again = await (await call('POST', '/rest/api/2/permissionscheme/templates/role-based', { name: 'Strict 2' })).json();
    expect(again.rolesCreated).toEqual([]);
    expect(roles.filter((r) => r.name === 'Commenters').length).toBe(1);
  });

  test('a project lead entry grants the permission to the lead of that project only', async () => {
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    const [lead] = await db.insert(schema.users).values({ username: 'leady', email: 'leady@veqsio.local', displayName: 'Leady', passwordHash: hash }).returning();
    const [outsider] = await db.insert(schema.users).values({ username: 'outsider', email: 'outsider@veqsio.local', displayName: 'Outsider', passwordHash: hash }).returning();
    const project = (await db.select().from(schema.projects))[0];
    await db.update(schema.projects).set({ leadId: lead.id }).where(eq(schema.projects.id, project.id));
    const [scheme] = await db.select().from(schema.permissionSchemes).limit(1);
    // the lead entry is stored and returned as a holder of type projectLead
    const created = await (await call('POST', '/rest/api/2/permissionscheme', { name: 'Lead scheme', permissions: [{ permission: 'BROWSE_PROJECTS', projectLead: true }] })).json();
    const listed = await (await call('GET', '/rest/api/2/permissionscheme')).json();
    const mine = listed.permissionSchemes.find((x: any) => x.id === created.id);
    expect(mine.permissions[0].holder).toMatchObject({ type: 'projectLead' });
    // it is evaluated through the shared predicate: lead yes, other user no
    await db.insert(schema.permissionEntries).values({ schemeId: scheme.id, permissionKey: 'EDIT_ALL_WORKLOGS', projectLead: true });
    const { checkProjectPermission } = await import('../../src/middleware/permissions');
    expect(await checkProjectPermission(lead as any, project.id, 'EDIT_ALL_WORKLOGS')).toBe(true);
    expect(await checkProjectPermission(outsider as any, project.id, 'EDIT_ALL_WORKLOGS')).toBe(false);
  });
});
