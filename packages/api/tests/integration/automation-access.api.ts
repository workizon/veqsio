import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Automation rules: who may manage them', () => {
  let seeded: any; let admin: string; let bob: string; let pa: string; let otherPa: string;
  let testSql: ReturnType<typeof createTestSql>;
  let otherProjectId: number;
  const as = (ck: () => string) => (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: ck() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const A = as(() => admin), B = as(() => bob), PA = as(() => pa), OPA = as(() => otherPa);
  const P = '/rest/api/2/automation/rule';
  const rule = (extra: object = {}) => ({ name: 'R', triggers: [{ triggerType: 'issue_created', config: {} }], actions: [{ actionType: 'add_label', config: { label: 'x' } }], ...extra });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = (u: string) => ({ username: u, email: `${u}@x.test`, displayName: u, passwordHash: hash });
    const [b, p, o] = await db.insert(schema.users).values([mk('plainbob'), mk('projadm'), mk('otheradm')]).returning();
    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTH', name: 'Other', leadId: seeded.user.id }).returning();
    otherProjectId = other.id;
    const [s2] = await db.insert(schema.permissionSchemes).values({ name: 'OTH' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: other.id, schemeId: s2.id });
    await db.insert(schema.permissionEntries).values([
      { schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: b.id },
      { schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: p.id },
      { schemeId: seeded.permScheme.id, permissionKey: 'PROJECT_ADMIN', userId: p.id },
      { schemeId: s2.id, permissionKey: 'BROWSE_PROJECTS', userId: o.id },
      { schemeId: s2.id, permissionKey: 'PROJECT_ADMIN', userId: o.id },
    ]);
    const login = async (u: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
    admin = await login('admin'); bob = await login('plainbob'); pa = await login('projadm'); otherPa = await login('otheradm');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('a plain user can neither create, list, read, change, run nor delete rules', async () => {
    expect((await B('POST', P, rule())).status).toBe(403);
    expect((await B('POST', P, rule({ projectId: seeded.project.id }))).status).toBe(403);
    const r = await (await A('POST', P, rule())).json(); // a global rule made by the administrator
    expect((await B('GET', P)).json && (await (await B('GET', P)).json()).values).toEqual([]);
    for (const [m, path, body] of [['GET', `${P}/${r.id}`], ['PUT', `${P}/${r.id}`, { name: 'x' }], ['DELETE', `${P}/${r.id}`], ['PUT', `${P}/${r.id}/toggle`, { isEnabled: false }], ['POST', `${P}/${r.id}/execute`, {}], ['GET', `${P}/${r.id}/execution`]] as const) {
      expect((await B(m, path, body)).status, `${m} ${path}`).toBe(404);
    }
    // the administrator's rule is untouched
    expect((await (await A('GET', `${P}/${r.id}`)).json()).name).toBe('R');
  });

  test('a project administrator manages the rules of their own project only', async () => {
    expect((await PA('POST', P, rule())).status).toBe(403); // a global rule is for system administrators
    expect((await PA('POST', P, rule({ projectId: otherProjectId }))).status).toBe(403);
    const mine = await PA('POST', P, rule({ projectId: seeded.project.id }));
    expect(mine.status).toBe(201);
    const id = (await mine.json()).id;
    expect((await (await PA('GET', P)).json()).values.map((v: any) => v.id)).toEqual([id]);
    expect((await PA('PUT', `${P}/${id}/toggle`, { isEnabled: false })).status).toBe(200);
    // moving it into a project they do not administer is refused
    expect((await PA('PUT', `${P}/${id}`, { projectId: otherProjectId })).status).toBe(403);
    // another project's administrator cannot see or touch it
    expect((await OPA('GET', `${P}/${id}`)).status).toBe(404);
    expect((await OPA('DELETE', `${P}/${id}`)).status).toBe(404);
    expect((await (await OPA('GET', P)).json()).values).toEqual([]);
    expect((await PA('DELETE', `${P}/${id}`)).status).toBe(200);
  });

  test('webhook actions are for system administrators; a project rule only runs on its own project', async () => {
    const hook = rule({ projectId: seeded.project.id, actions: [{ actionType: 'send_webhook', config: { url: 'https://hooks.example/x' } }] });
    expect((await PA('POST', P, hook)).status).toBe(403);
    expect((await A('POST', P, hook)).status).toBe(201);
    const [i] = await createTestDb(testSql).insert(schema.issues).values({ projectId: otherProjectId, issueKey: 'OTH-1', issueNumber: 1, summary: 's', issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id, reporterId: seeded.user.id } as any).returning();
    const mine = await (await A('POST', P, rule({ projectId: seeded.project.id }))).json();
    expect(i.issueKey).toBe('OTH-1');
    expect((await A('POST', `${P}/${mine.id}/execute`, { issueKey: 'OTH-1' })).status).toBe(400);
  });
});
