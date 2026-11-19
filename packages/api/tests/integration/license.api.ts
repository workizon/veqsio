import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { hasFeature, refreshLicense, setLicensePublicKeysForTests } from '../../src/license';

describe('Licence admin API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let admin = '', bob = '';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const mint = (over: Record<string, unknown> = {}) => {
    const payload = {
      v: 1, kid: 'it', id: 'lic-it', customer: 'Integration Ltd', plan: 'enterprise', features: [],
      issuedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...over,
    };
    const head = `VQL1.${b64u(JSON.stringify(payload))}`;
    return `${head}.${b64u(sign(null, Buffer.from(head), privateKey))}`;
  };

  const login = async (username: string) => (await app.request('/rest/auth/1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
  })).headers.get('set-cookie') || '';
  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    delete process.env.VEQSIO_LICENSE_KEY;
    delete process.env.VEQSIO_LICENSE_FILE;
    setLicensePublicKeysForTests([{ kid: 'it', pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]);
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    await refreshLicense();
    admin = await login('admin');
    bob = await login('bob');
  });

  afterAll(async () => {
    setLicensePublicKeysForTests(null);
    await refreshLicense();
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('starts as community; any signed-in user can read the status, anonymous cannot', async () => {
    let res = await call(bob, 'GET', '/rest/api/2/license/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'none', plan: 'community', features: [] });
    res = await app.request('/rest/api/2/license/status');
    expect(res.status).toBe(401);
    expect(hasFeature('sso_saml')).toBe(false);
  });

  test('only system administrators manage the licence', async () => {
    expect((await call(bob, 'GET', '/rest/api/2/admin/license')).status).toBe(403);
    expect((await call(bob, 'PUT', '/rest/api/2/admin/license', { key: mint() })).status).toBe(403);
    expect((await call(bob, 'DELETE', '/rest/api/2/admin/license')).status).toBe(403);
  });

  test('invalid, forged and badly shaped keys are rejected and not stored', async () => {
    expect((await call(admin, 'PUT', '/rest/api/2/admin/license', { key: 'not-a-licence-key' })).status).toBe(400);
    const forged = mint().split('.');
    forged[1] = b64u(JSON.stringify({ v: 1, kid: 'it', id: 'x', customer: 'Evil', plan: 'enterprise', features: [], issuedAt: new Date().toISOString(), expiresAt: null }));
    const res = await call(admin, 'PUT', '/rest/api/2/admin/license', { key: forged.join('.') });
    expect(res.status).toBe(400);
    expect((await res.json()).errorMessages[0]).toContain('signature');
    expect((await call(admin, 'PUT', '/rest/api/2/admin/license', { key: mint(), extra: 1 })).status).toBe(400);
    expect(hasFeature('sso_saml')).toBe(false);
  });

  test('a valid key unlocks enterprise features, survives a refresh and never leaks through the API', async () => {
    const key = mint();
    const res = await call(admin, 'PUT', '/rest/api/2/admin/license', { key });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'valid', plan: 'enterprise', customer: 'Integration Ltd' });
    expect(JSON.stringify(body)).not.toContain(key);
    expect(hasFeature('sso_saml')).toBe(true);

    await refreshLicense(); // reads the stored key back from the database
    expect(hasFeature('scim')).toBe(true);
    expect((await (await call(bob, 'GET', '/rest/api/2/license/status')).json()).plan).toBe('enterprise');
  });

  test('removing the key returns the instance to the community edition without touching data', async () => {
    const res = await call(admin, 'DELETE', '/rest/api/2/admin/license');
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('none');
    expect(hasFeature('sso_saml')).toBe(false);
    expect(hasFeature('boards')).toBe(true);
  });

  test('an expired licence is accepted for the record but switches paid features off', async () => {
    const expired = mint({ issuedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-06-01T00:00:00Z' });
    const res = await call(admin, 'PUT', '/rest/api/2/admin/license', { key: expired });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('expired');
    expect(hasFeature('sso_saml')).toBe(false);
    await call(admin, 'DELETE', '/rest/api/2/admin/license');
  });
});
