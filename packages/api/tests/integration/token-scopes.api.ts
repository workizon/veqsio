import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { useTestLicense, clearTestLicense } from '../test-license';
import { resetRateLimits } from '../reset-rate-limits';

describe('Personal access token scopes and expiry policy', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let issueKey: string;

  const create = (body: unknown, auth: { cookie?: string; bearer?: string } = { cookie: adminCookie }) =>
    app.request('/rest/api/2/mypersonalaccessTokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  const withToken = (token: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mint = async (scopes: string[]) => (await (await create({ name: scopes.join(','), scopes })).json()).token as string;
  const scopeDenied = async (res: Response) => res.status === 403 && (await res.json()).errorMessages?.[0] === 'Token scope does not permit this request';

  beforeAll(async () => {
    await resetRateLimits();
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pw-123456' }) });
    adminCookie = login.headers.get('set-cookie') || '';
    const [issue] = await db.insert(schema.issues).values({
      projectId: seeded.project.id, issueKey: 'TEST-1', issueNumber: 1, summary: 'scoped', issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id, reporterId: seeded.user.id,
    } as any).returning();
    issueKey = issue.issueKey;
  });

  afterAll(async () => {
    delete process.env.PAT_MAX_EXPIRY_DAYS;
    delete process.env.PAT_DEFAULT_EXPIRY_DAYS;
    await resetTestDb(testSql);
    await testSql.end();
  });

  describe('creation and expiry policy', () => {
    test('defaults: unrestricted scope, 90 day expiry', async () => {
      const res = await create({ name: 'default' });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scopes).toEqual(['*']);
      const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
      const [row] = await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.id, body.id));
      expect(row.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
    });

    test('custom expiry up to the maximum; beyond is refused', async () => {
      expect((await create({ name: 'a', expiresInDays: 30 })).status).toBe(201);
      expect((await create({ name: 'b', expiresInDays: 365 })).status).toBe(201);
      const res = await create({ name: 'c', expiresInDays: 366 });
      expect(res.status).toBe(400);
      expect((await create({ name: 'd', expiresInDays: 0 })).status).toBe(400);
      expect((await create({ name: 'e', expiresInDays: 1.5 })).status).toBe(400);
      process.env.PAT_MAX_EXPIRY_DAYS = '30';
      expect((await create({ name: 'f', expiresInDays: 31 })).status).toBe(400);
      const ok = await (await create({ name: 'g' })).json(); // default is capped by the max
      expect((new Date(ok.expiresAt).getTime() - Date.now()) / 86400000).toBeLessThan(30.1);
      delete process.env.PAT_MAX_EXPIRY_DAYS;
    });

    test('rejects unknown scopes and unknown fields', async () => {
      expect((await create({ name: 'x', scopes: ['superuser'] })).status).toBe(400);
      expect((await create({ name: 'x', scopes: [] })).status).toBe(400);
      expect((await create({ name: 'x', userId: 1 })).status).toBe(400);
    });

    test('policy endpoint', async () => {
      const res = await app.request('/rest/api/2/mypersonalaccessTokens/policy', { headers: { Cookie: adminCookie } });
      const body = await res.json();
      expect(body.defaultDays).toBe(90);
      expect(body.maxDays).toBe(365);
      expect(body.scopes).toContain('read:issues');
    });

    test('expired tokens are refused', async () => {
      const t = 'veqsio_' + 'c'.repeat(64);
      const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin'));
      await db.insert(schema.personalAccessTokens).values({ userId: admin.id, name: 'old', tokenHash: createHash('sha256').update(t).digest('hex'), scopes: ['*'], expiresAt: new Date(Date.now() - 1000) });
      expect((await withToken(t, 'GET', '/rest/api/2/myself')).status).toBe(401);
    });
  });

  describe('enforcement', () => {
    test('legacy and wildcard tokens behave as before', async () => {
      const legacy = 'veqsio_' + 'd'.repeat(64);
      const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin'));
      await db.insert(schema.personalAccessTokens).values({ userId: admin.id, name: 'legacy', tokenHash: createHash('sha256').update(legacy).digest('hex'), scopes: ['read', 'write'] });
      expect(await scopeDenied(await withToken(legacy, 'GET', '/rest/api/2/admin/oidc'))).toBe(false);
      expect((await withToken(legacy, 'GET', '/rest/api/2/admin/oidc')).status).toBe(200);
      const star = await mint(['*']);
      expect((await withToken(star, 'GET', '/rest/api/2/admin/oidc')).status).toBe(200);
      expect((await withToken(star, 'GET', `/rest/api/2/issue/${issueKey}`)).status).toBe(200);
    });

    test('read:* may only GET/HEAD', async () => {
      const t = await mint(['read:*']);
      expect((await withToken(t, 'GET', '/rest/api/2/myself')).status).toBe(200);
      expect((await withToken(t, 'GET', `/rest/api/2/issue/${issueKey}`)).status).toBe(200);
      expect((await withToken(t, 'HEAD', `/rest/api/2/issue/${issueKey}`)).status).not.toBe(403);
      for (const [m, p] of [['POST', '/rest/api/2/issue'], ['PUT', `/rest/api/2/issue/${issueKey}`], ['DELETE', `/rest/api/2/issue/${issueKey}`], ['POST', `/rest/api/2/issue/${issueKey}/comment`], ['POST', '/rest/api/2/project']] as const) {
        expect(await scopeDenied(await withToken(t, m, p, {}))).toBe(true);
      }
      expect(await scopeDenied(await withToken(t, 'GET', '/rest/api/2/admin/oidc'))).toBe(true);
      expect(await scopeDenied(await withToken(t, 'GET', '/scim/v2/Users'))).toBe(true);
    });

    test('write:issues covers issues, comments and worklogs, nothing else', async () => {
      const t = await mint(['write:issues']);
      const c = await withToken(t, 'POST', `/rest/api/2/issue/${issueKey}/comment`, { body: 'via token' });
      expect(await scopeDenied(c)).toBe(false);
      expect(c.status).toBe(201);
      const w = await withToken(t, 'POST', `/rest/api/2/issue/${issueKey}/worklog`, { timeSpentSeconds: 60 });
      expect(await scopeDenied(w)).toBe(false);
      expect(await scopeDenied(await withToken(t, 'POST', '/rest/api/2/project', { key: 'ZZZ', name: 'z' }))).toBe(true);
      expect(await scopeDenied(await withToken(t, 'GET', '/rest/api/2/project'))).toBe(true);
      expect(await scopeDenied(await withToken(t, 'GET', '/rest/api/2/admin/oidc'))).toBe(true);
      expect(await scopeDenied(await withToken(t, 'GET', '/rest/api/2/mypersonalaccessTokens'))).toBe(true);
    });

    test('read:issues cannot comment', async () => {
      const t = await mint(['read:issues']);
      expect((await withToken(t, 'GET', `/rest/api/2/issue/${issueKey}`)).status).toBe(200);
      expect(await scopeDenied(await withToken(t, 'POST', `/rest/api/2/issue/${issueKey}/comment`, { body: 'x' }))).toBe(true);
      expect(await scopeDenied(await withToken(t, 'GET', '/rest/api/2/project'))).toBe(true);
    });

    test('admin scope reaches admin paths (still subject to permissions)', async () => {
      const t = await mint(['admin']);
      expect((await withToken(t, 'GET', '/rest/api/2/admin/oidc')).status).toBe(200);
      // SCIM is an enterprise feature: without a licence the handler is reached but refuses with 402 (not a scope 403)
      expect((await withToken(t, 'POST', '/rest/api/2/admin/scim/tokens', { name: 'viaPat' })).status).toBe(402);
      await useTestLicense({ plan: 'enterprise' });
      try {
        expect((await withToken(t, 'POST', '/rest/api/2/admin/scim/tokens', { name: 'viaPat' })).status).toBe(201);
      } finally {
        await clearTestLicense();
      }
    });

    test('a scoped token cannot mint a more powerful token', async () => {
      const readOnly = await mint(['read:*']);
      expect(await scopeDenied(await create({ name: 'esc', scopes: ['*'] }, { bearer: readOnly }))).toBe(true);
      const admin = await mint(['admin']);
      const res = await create({ name: 'esc2', scopes: ['*'] }, { bearer: admin });
      expect(res.status).toBe(403);
    });

    test('cookie sessions are not limited by token scopes', async () => {
      const res = await app.request('/rest/api/2/admin/oidc', { headers: { Cookie: adminCookie } });
      expect(res.status).toBe(200);
    });

    test('a revoked token stops working', async () => {
      const created = await (await create({ name: 'tmp', scopes: ['read:*'] })).json();
      expect((await withToken(created.token, 'GET', '/rest/api/2/myself')).status).toBe(200);
      await app.request(`/rest/api/2/mypersonalaccessTokens/${created.id}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      expect((await withToken(created.token, 'GET', '/rest/api/2/myself')).status).toBe(401);
    });
  });
});
