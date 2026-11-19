import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { clearTestLicense, mintTestLicense, useTestLicense } from '../test-license';

describe('Licence gates and seat limit', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin = '', bob = '';
  const scimToken = 'scim_' + 'a'.repeat(64);
  const DAY = 86_400_000;

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const scim = (method: string, path: string, body?: unknown) =>
    app.request(`/scim/v2${path}`, {
      method, headers: { 'Content-Type': 'application/scim+json', Authorization: `Bearer ${scimToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string) => (await app.request('/rest/auth/1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
  })).headers.get('set-cookie') || '';
  const activeCount = async () => (await db.select().from(schema.users)).filter((u) => u.active !== false).length;
  const newUser = (n: string) => ({ username: n, email: `${n}@example.com`, displayName: n, password: 'pw-123456' });
  const scimUser = (n: string) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `${n}@example.com`, name: { givenName: 'T', familyName: n },
    emails: [{ value: `${n}@example.com`, primary: true }], active: true,
  });

  beforeAll(async () => {
    await resetRateLimits();
    await clearTestLicense();
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    await db.delete(schema.scimTokens);
    // A SCIM token that predates the licence (as after a licence ended): created directly, as an earlier licence would have.
    await db.insert(schema.scimTokens).values({ name: 'old', tokenHash: createHash('sha256').update(scimToken).digest('hex'), createdBy: seeded.user.id });
    admin = await login('admin');
    bob = await login('bob');
  });

  afterAll(async () => {
    await clearTestLicense();
    await db.delete(schema.scimTokens);
    await resetTestDb(testSql);
    await testSql.end();
  });

  describe('community instance', () => {
    test('enterprise endpoints refuse with 402 and an upgrade hint', async () => {
      const res = await call(admin, 'GET', '/rest/api/2/admin/audit/export');
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body).toMatchObject({ feature: 'audit_export', licence: 'none', upgrade: { plan: 'team', manage: '/admin/license' } });
      expect(body.errorMessages[0]).toContain('Audit log export');

      const t = await call(admin, 'POST', '/rest/api/2/admin/scim/tokens', { name: 'x' });
      expect(t.status).toBe(402);
      expect((await t.json()).upgrade.plan).toBe('enterprise');

      expect((await call(admin, 'POST', '/rest/api/2/admin/oidc', { name: 'n' })).status).toBe(402);
      expect((await call(admin, 'POST', '/rest/api/2/admin/oidc/1/test')).status).toBe(402);

      const s = await scim('GET', '/Users');
      expect(s.status).toBe(402);
      expect(s.headers.get('content-type')).toContain('scim+json');
    });

    test('anonymous SCIM callers still get 401, not 402', async () => {
      const res = await app.request('/scim/v2/Users', { headers: { Authorization: 'Bearer ' + 'z'.repeat(40) } });
      expect(res.status).toBe(401);
    });

    test('everything documented as community keeps working, and existing data stays readable', async () => {
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit')).status).toBe(200);
      expect((await call(admin, 'GET', '/rest/api/2/admin/scim/tokens')).status).toBe(200);
      expect((await (await call(admin, 'GET', '/rest/api/2/admin/scim/tokens')).json()).length).toBe(1);
      expect((await call(admin, 'GET', '/rest/api/2/admin/oidc')).status).toBe(200);
      expect((await call(admin, 'GET', '/rest/api/2/project')).status).toBe(200);
      expect((await call(admin, 'GET', '/rest/api/2/search?jql=' + encodeURIComponent('order by created'))).status).toBe(200);
      const created = await call(admin, 'POST', '/rest/api/2/user', newUser('community-user'));
      expect(created.status).toBe(201); // no seat limit in community
    });

    test('the status endpoint reports community', async () => {
      expect(await (await call(bob, 'GET', '/rest/api/2/license/status')).json()).toMatchObject({ state: 'none', plan: 'community', features: [] });
    });
  });

  describe('licensed instance', () => {
    test('a valid enterprise licence opens the gated endpoints', async () => {
      await useTestLicense({ features: [] });
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit/export')).status).toBe(200);
      expect((await scim('GET', '/Users')).status).toBe(200);
      const t = await call(admin, 'POST', '/rest/api/2/admin/scim/tokens', { name: 'new' });
      expect(t.status).toBe(201);
      // gate passes, then validation rejects the empty body: 400 proves the gate did not answer 402
      expect((await call(admin, 'POST', '/rest/api/2/admin/oidc', { name: 'n' })).status).toBe(400);
    });

    test('a team licence includes audit export but not SCIM', async () => {
      await useTestLicense({ plan: 'team' });
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit/export')).status).toBe(200);
      expect((await scim('GET', '/Users')).status).toBe(402);
    });

    test('an individually granted feature works on its own', async () => {
      await useTestLicense({ plan: 'community', features: ['scim'] });
      expect((await scim('GET', '/Users')).status).toBe(200);
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit/export')).status).toBe(402);
    });

    test('grace period keeps features on; after it ends they switch off but data stays readable', async () => {
      await useTestLicense({ issuedAt: new Date(Date.now() - 400 * DAY).toISOString(), expiresAt: new Date(Date.now() - 3 * DAY).toISOString() });
      expect(await (await call(bob, 'GET', '/rest/api/2/license/status')).json()).toMatchObject({ state: 'grace', plan: 'enterprise' });
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit/export')).status).toBe(200);
      const view = await (await call(admin, 'GET', '/rest/api/2/admin/license')).json();
      expect(view).toMatchObject({ state: 'grace', keyStatus: 'grace', expiryWarning: true });

      await useTestLicense({ issuedAt: new Date(Date.now() - 400 * DAY).toISOString(), expiresAt: new Date(Date.now() - 60 * DAY).toISOString() });
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit/export')).status).toBe(402);
      expect((await scim('GET', '/Users')).status).toBe(402);
      expect(await (await call(bob, 'GET', '/rest/api/2/license/status')).json()).toMatchObject({ state: 'expired', plan: 'community' });
      // data is still there
      expect((await call(admin, 'GET', '/rest/api/2/admin/audit')).status).toBe(200);
      expect((await (await call(admin, 'GET', '/rest/api/2/admin/scim/tokens')).json()).length).toBeGreaterThan(0);
      expect((await call(admin, 'GET', '/rest/api/2/admin/oidc')).status).toBe(200);
      const view2 = await (await call(admin, 'GET', '/rest/api/2/admin/license')).json();
      expect(view2).toMatchObject({ edition: 'community', keyStatus: 'expired', seatsEnforced: false });
    });
  });

  describe('admin view', () => {
    test('days to expiry, warning at 30 days, seats in use, key never returned', async () => {
      const key = mintTestLicense({ seats: 500, expiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
      await useTestLicense(null);
      const put = await call(admin, 'PUT', '/rest/api/2/admin/license', { key });
      expect(put.status).toBe(200);
      const text = await put.text();
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.split('.')[2]);
      const view = JSON.parse(text);
      expect(view).toMatchObject({ edition: 'enterprise', state: 'valid', keyStatus: 'valid', keySource: 'database', customer: 'Test Ltd', seats: 500, seatsEnforced: true, expiryWarning: true });
      expect(view.daysToExpiry).toBeGreaterThanOrEqual(19);
      expect(view.daysToExpiry).toBeLessThanOrEqual(20);
      expect(view.seatsInUse).toBe(await activeCount());
      expect(view.featureList.find((f: any) => f.key === 'scim')).toMatchObject({ label: 'SCIM user provisioning', enabled: true });

      const got = await (await call(admin, 'GET', '/rest/api/2/admin/license')).text();
      expect(got).not.toContain(key);
      expect(got).not.toContain(key.split('.')[1]);

      // far from expiry: no warning
      const far = JSON.parse(await (await call(admin, 'PUT', '/rest/api/2/admin/license', { key: mintTestLicense() })).text());
      expect(far.expiryWarning).toBe(false);
      expect((await call(admin, 'DELETE', '/rest/api/2/admin/license')).status).toBe(200);
    });

    test('key status for unknown key id and bad signature; invalid keys are not stored', async () => {
      await useTestLicense(null);
      const good = mintTestLicense();
      const parts = good.split('.');
      const other = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      other.kid = 'nope';
      const unknown = await call(admin, 'PUT', '/rest/api/2/admin/license', { key: [parts[0], Buffer.from(JSON.stringify(other)).toString('base64url'), parts[2]].join('.') });
      expect(unknown.status).toBe(400);
      expect((await unknown.json()).keyStatus).toBe('key_unknown');

      other.kid = 'it'; other.customer = 'Forged';
      const forged = await call(admin, 'PUT', '/rest/api/2/admin/license', { key: [parts[0], Buffer.from(JSON.stringify(other)).toString('base64url'), parts[2]].join('.') });
      expect(forged.status).toBe(400);
      expect((await forged.json()).keyStatus).toBe('invalid_signature');
      expect((await (await call(admin, 'GET', '/rest/api/2/admin/license')).json()).keyStatus).toBe('not_set');
    });
  });

  describe('seat limit', () => {
    test('admin create, reactivation, SCIM create and SCIM reactivation respect the limit; existing users keep working', async () => {
      const inUse = await activeCount();
      await useTestLicense({ seats: inUse + 1, features: [] });

      // one free seat: admin creates a user
      expect((await call(admin, 'POST', '/rest/api/2/user', newUser('seat-a'))).status).toBe(201);

      // full now: admin create is refused, with a clear message
      const refused = await call(admin, 'POST', '/rest/api/2/user', newUser('seat-b'));
      expect(refused.status).toBe(402);
      const body = await refused.json();
      expect(body).toMatchObject({ feature: 'seats', seats: { limit: inUse + 1, inUse: inUse + 1 } });
      expect(body.errorMessages[0]).toContain('seat limit');
      // creating an inactive user does not take a seat
      expect((await call(admin, 'POST', '/rest/api/2/user', { ...newUser('seat-inactive'), active: false })).status).toBe(201);
      // activating it would
      const react = await call(admin, 'PUT', '/rest/api/2/user', { username: 'seat-inactive', active: true });
      expect(react.status).toBe(402);
      // editing an active user is fine
      expect((await call(admin, 'PUT', '/rest/api/2/user', { username: 'seat-a', displayName: 'Renamed' })).status).toBe(200);

      // SCIM
      const sc = await scim('POST', '/Users', scimUser('scim-a'));
      expect(sc.status).toBe(402);
      expect((await sc.json()).detail).toContain('seat limit');
      expect((await scim('POST', '/Users', { ...scimUser('scim-inactive'), active: false })).status).toBe(201);
      const [scimInactive] = await db.select().from(schema.users).where(eq(schema.users.username, 'scim-inactive@example.com'));
      const put = await scim('PUT', `/Users/${scimInactive.id}`, scimUser('scim-inactive'));
      expect(put.status).toBe(402);

      // existing users still sign in
      expect((await login('bob')).length).toBeGreaterThan(0);
      expect((await call(bob, 'GET', '/rest/api/2/myself')).status).toBe(200);

      // freeing a seat makes room again
      await call(admin, 'PUT', '/rest/api/2/user', { username: 'seat-a', active: false });
      expect((await call(admin, 'PUT', '/rest/api/2/user', { username: 'seat-inactive', active: true })).status).toBe(200);
      expect((await scim('POST', '/Users', scimUser('scim-b'))).status).toBe(402);
    });

    test('an expired licence imposes no seat limit (community)', async () => {
      await useTestLicense({ seats: 1, issuedAt: new Date(Date.now() - 400 * DAY).toISOString(), expiresAt: new Date(Date.now() - 60 * DAY).toISOString() });
      expect((await call(admin, 'POST', '/rest/api/2/user', newUser('after-expiry'))).status).toBe(201);
    });
  });
});
