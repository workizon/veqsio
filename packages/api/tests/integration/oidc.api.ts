import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { useTestLicense, clearTestLicense } from '../test-license';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import { FakeIdp } from '../fake-idp';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { oidcClient } from '../../src/auth/oidc-client';

describe('Generic OIDC SSO', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let userCookie: string;
  const idp = new FakeIdp('https://idp.test');
  const CLIENT_ID = 'veqsio-client';
  const SECRET = 'plain-client-secret-xyz';
  let bcryptHash: string;

  const json = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  const passwordLogin = async (username: string, password = 'pw-123456') => {
    const res = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return { res, cookie: res.headers.get('set-cookie') || '' };
  };

  const cookieOf = (res: Response, name: string) => {
    const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return line ? line.split(';')[0].slice(name.length + 1) : undefined;
  };

  const providerBody = (over: Record<string, unknown> = {}) => ({
    name: 'Fake IdP', slug: 'fake', issuer: idp.issuer, clientId: CLIENT_ID, clientSecret: SECRET,
    scopes: 'openid profile email groups', groupsClaim: 'groups', allowedDomains: [], autoProvision: true, linkByEmail: false, enforceSso: false, enabled: true,
    ...over,
  });

  async function setProvider(over: Record<string, unknown> = {}) {
    await db.delete(schema.oidcProviders);
    const res = await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody(over));
    expect(res.status).toBe(201);
  }

  /** Start a login; returns what the browser would carry to the callback. */
  async function begin(next?: string) {
    const res = await app.request(`/rest/auth/1/oidc/fake/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://idp.test/authorize');
    return {
      state: loc.searchParams.get('state')!,
      nonce: loc.searchParams.get('nonce')!,
      challenge: loc.searchParams.get('code_challenge')!,
      bind: cookieOf(res, 'oidc_bind')!,
      params: loc.searchParams,
    };
  }

  async function callback(s: { state: string; bind?: string }, code = 'good-code') {
    return app.request(`/rest/auth/1/oidc/fake/callback?code=${code}&state=${encodeURIComponent(s.state)}`, {
      headers: s.bind ? { Cookie: `oidc_bind=${s.bind}` } : {},
    });
  }

  /** Full flow with a configurable ID token. */
  async function flow(claims: Record<string, unknown> = {}, opts: { alg?: string; nonceOverride?: string; next?: string; clientId?: string; omitBind?: boolean; key?: any } = {}) {
    const s = await begin(opts.next);
    idp.codeChallenge = s.challenge;
    idp.mintIdToken = () => idp.idToken(opts.clientId ?? CLIENT_ID, opts.nonceOverride ?? s.nonce, claims, { alg: opts.alg, key: opts.key });
    const res = await callback({ state: s.state, bind: opts.omitBind ? undefined : s.bind });
    return { res, s, location: res.headers.get('location') ?? '', session: cookieOf(res, 'session') };
  }

  const expectFailure = (r: { location: string; session?: string }, code: string) => {
    expect(r.location).toBe(`/login?sso_error=${code}`);
    expect(r.session).toBeUndefined();
  };

  // The callback URL is built from OIDC_REDIRECT_BASE_URL, then PUBLIC_URL, then WEB_URL. CI sets WEB_URL, so pin the
  // base here to keep the expected redirect_uri independent of the environment.
  const savedEnv = { base: process.env.OIDC_REDIRECT_BASE_URL };
  beforeAll(async () => {
    process.env.OIDC_REDIRECT_BASE_URL = 'http://localhost';
    await resetRateLimits();
    await useTestLicense({ features: ['scim', 'sso_oidc_generic'] });
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    bcryptHash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: bcryptHash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'plain', email: 'plain@example.com', displayName: 'Plain', passwordHash: bcryptHash });
    adminCookie = (await passwordLogin('admin')).cookie;
    userCookie = (await passwordLogin('plain')).cookie;
    oidcClient.setFetch(idp.fetch);
  });

  afterAll(async () => {
    if (savedEnv.base === undefined) delete process.env.OIDC_REDIRECT_BASE_URL; else process.env.OIDC_REDIRECT_BASE_URL = savedEnv.base;
    await clearTestLicense();
    await db.delete(schema.oidcProviders);
    await resetTestDb(testSql);
    await testSql.end();
  });

  beforeEach(async () => {
    await resetRateLimits();
    // Fresh users/identities per test, but keep admin + plain.
    await db.delete(schema.users).where(eq(schema.users.email, 'jane@example.com'));
    await db.delete(schema.userIdentities);
    await db.delete(schema.groups).where(eq(schema.groups.description, 'Synced from Fake IdP'));
    oidcClient.clearCaches();
  });

  describe('admin API', () => {
    test('create never returns or stores the secret in the clear', async () => {
      await db.delete(schema.oidcProviders);
      const res = await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody());
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.hasSecret).toBe(true);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(body.clientSecret).toBeUndefined();
      expect(body.clientSecretEncrypted).toBeUndefined();
      const [row] = await db.select().from(schema.oidcProviders);
      expect(row.clientSecretEncrypted).not.toContain(SECRET);
      expect(row.clientSecretEncrypted.startsWith('v1.')).toBe(true);
      const list = await (await json(adminCookie, 'GET', '/rest/api/2/admin/oidc')).json();
      expect(JSON.stringify(list)).not.toContain(SECRET);
      expect(list[0].hasSecret).toBe(true);
    });

    test('system admin only', async () => {
      expect((await json(userCookie, 'GET', '/rest/api/2/admin/oidc')).status).toBe(403);
      expect((await json(userCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'other' }))).status).toBe(403);
      expect((await app.request('/rest/api/2/admin/oidc')).status).toBe(401);
    });

    test('validation: strict keys, https issuer, slug, scopes, duplicate slug', async () => {
      await setProvider();
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'fake' }))).status).toBe(409);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'b1', issuer: 'http://idp.test' }))).status).toBe(400);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'Bad Slug' }))).status).toBe(400);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'b2', scopes: 'profile' }))).status).toBe(400);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'b3', evil: true }))).status).toBe(400);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'b4', allowedDomains: ['not a domain'] }))).status).toBe(400);
    });

    test('update keeps the secret when omitted, replaces it when given; delete', async () => {
      await setProvider();
      const [row] = await db.select().from(schema.oidcProviders);
      const before = row.clientSecretEncrypted;
      let res = await json(adminCookie, 'PUT', `/rest/api/2/admin/oidc/${row.id}`, { name: 'Renamed', enabled: false });
      expect(res.status).toBe(200);
      expect((await res.json()).name).toBe('Renamed');
      expect((await db.select().from(schema.oidcProviders))[0].clientSecretEncrypted).toBe(before);
      res = await json(adminCookie, 'PUT', `/rest/api/2/admin/oidc/${row.id}`, { clientSecret: 'new-secret' });
      expect((await db.select().from(schema.oidcProviders))[0].clientSecretEncrypted).not.toBe(before);
      expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/oidc/${row.id}`, { slug: 'nope' })).status).toBe(400);
      expect((await json(adminCookie, 'DELETE', `/rest/api/2/admin/oidc/${row.id}`)).status).toBe(204);
      expect((await json(adminCookie, 'GET', `/rest/api/2/admin/oidc/${row.id}`)).status).toBe(404);
    });

    test('public provider list shows only enabled name and slug', async () => {
      await setProvider();
      await json(adminCookie, 'POST', '/rest/api/2/admin/oidc', providerBody({ slug: 'off', name: 'Off', enabled: false }));
      const res = await app.request('/rest/auth/1/oidc/providers');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ name: 'Fake IdP', slug: 'fake' }]);
    });

    test('discovery test endpoint', async () => {
      await setProvider();
      const [row] = await db.select().from(schema.oidcProviders);
      const res = await json(adminCookie, 'POST', `/rest/api/2/admin/oidc/${row.id}/test`);
      expect((await res.json()).ok).toBe(true);
    });
  });

  describe('login flow', () => {
    test('happy path: PKCE+nonce, user provisioned, groups synced, session cookie, no tokens in URL', async () => {
      await setProvider();
      const { res, s, location, session } = await flow({ groups: ['eng', 'ops'] });
      // authorize request was well formed
      expect(s.params.get('response_type')).toBe('code');
      expect(s.params.get('client_id')).toBe(CLIENT_ID);
      expect(s.params.get('code_challenge_method')).toBe('S256');
      expect(s.params.get('redirect_uri')).toBe('http://localhost/rest/auth/1/oidc/fake/callback');
      // token exchange carried the verifier and the decrypted secret
      expect(idp.lastTokenRequest!.get('client_secret')).toBe(SECRET);
      expect(idp.lastTokenRequest!.get('code_verifier')).toBeTruthy();
      expect(res.status).toBe(302);
      expect(location).toBe('/dashboard');
      expect(location).not.toMatch(/token|code=|state=/);
      expect(session).toBeTruthy();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      expect(user.passwordHash).toBeNull();
      expect(user.displayName).toBe('Jane Doe');
      const [ident] = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, user.id));
      expect(ident.provider).toBe('oidc:fake');
      expect(ident.providerUserId).toBe('sub-123');
      const memberships = await db.select({ name: schema.groups.name }).from(schema.userGroups)
        .innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(eq(schema.userGroups.userId, user.id));
      expect(memberships.map((m) => m.name).sort()).toEqual(['eng', 'ops']);
      // the session works
      const me = await app.request('/rest/api/2/myself', { headers: { Cookie: `session=${session}` } });
      expect(me.status).toBe(200);
      expect((await me.json()).emailAddress ?? 'jane@example.com').toBe('jane@example.com');
    });

    test('second login reuses the identity; dropping a group only removes IdP-synced memberships', async () => {
      await setProvider();
      await flow({ groups: ['eng', 'ops'] });
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      // a manual membership in an unrelated group must survive
      const [manual] = await db.insert(schema.groups).values({ name: 'manual-group' }).returning();
      await db.insert(schema.userGroups).values({ userId: user.id, groupId: manual.id });
      const second = await flow({ groups: ['eng'], name: 'Jane Changed' });
      expect(second.location).toBe('/dashboard');
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(1);
      expect((await db.select().from(schema.userIdentities)).length).toBe(1);
      const memberships = await db.select({ name: schema.groups.name }).from(schema.userGroups)
        .innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(eq(schema.userGroups.userId, user.id));
      expect(memberships.map((m) => m.name).sort()).toEqual(['eng', 'manual-group']);
      await db.delete(schema.groups).where(eq(schema.groups.id, manual.id));
    });

    test('post-login redirect is same-origin only', async () => {
      await setProvider();
      expect((await flow({}, { next: '/browse/ABC-1?x=1' })).location).toBe('/browse/ABC-1?x=1');
      for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/\r\nSet-Cookie:x=1']) {
        const r = await flow({}, { next: evil });
        expect(r.location).toBe('/dashboard');
      }
    });

    test('unknown or disabled provider', async () => {
      await setProvider({ enabled: false });
      expect((await app.request('/rest/auth/1/oidc/fake/login')).status).toBe(404);
      expect((await app.request('/rest/auth/1/oidc/nope/login')).status).toBe(404);
    });

    test('bad state, replayed state, missing binding cookie', async () => {
      await setProvider();
      let r = await callback({ state: 'x'.repeat(40), bind: 'whatever' });
      expectFailure({ location: r.headers.get('location')!, session: cookieOf(r, 'session') }, 'invalid_state');
      // state valid but no binding cookie (login CSRF): refused, and the state is burned
      const noBind = await flow({}, { omitBind: true });
      expectFailure(noBind, 'invalid_state');
      // replay
      const s = await begin();
      idp.codeChallenge = s.challenge;
      idp.mintIdToken = () => idp.idToken(CLIENT_ID, s.nonce);
      expect((await callback(s)).headers.get('location')).toBe('/dashboard');
      r = await callback(s);
      expect(r.headers.get('location')).toBe('/login?sso_error=invalid_state');
      // wrong browser: state from one flow, cookie from another
      const a = await begin();
      const b = await begin();
      r = await callback({ state: a.state, bind: b.bind });
      expect(r.headers.get('location')).toBe('/login?sso_error=invalid_state');
    });

    test('wrong nonce', async () => {
      await setProvider();
      expectFailure(await flow({}, { nonceOverride: 'attacker-nonce' }), 'token_invalid');
    });

    test('wrong audience', async () => {
      await setProvider();
      expectFailure(await flow({}, { clientId: 'another-client' }), 'token_invalid');
    });

    test('wrong issuer', async () => {
      await setProvider();
      expectFailure(await flow({ iss: 'https://evil.test' }), 'token_invalid');
    });

    test('expired token (beyond clock skew)', async () => {
      await setProvider();
      const past = Math.floor(Date.now() / 1000) - 3600;
      expectFailure(await flow({ iat: past - 300, exp: past }), 'token_invalid');
    });

    test('alg none and HS256 are rejected', async () => {
      await setProvider();
      expectFailure(await flow({}, { alg: 'none' }), 'token_invalid');
      expectFailure(await flow({}, { alg: 'HS256' }), 'token_invalid');
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(0);
    });

    test('token signed by an unknown key is rejected; ES256 is accepted', async () => {
      await setProvider();
      const { generateKeyPairSync } = await import('crypto');
      const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
      expectFailure(await flow({}, { alg: 'RS256', key: rogue.privateKey }), 'token_invalid');
      const ok = await flow({ sub: 'es-sub', email: 'es@example.com' }, { alg: 'ES256' });
      expect(ok.location).toBe('/dashboard');
      await db.delete(schema.users).where(eq(schema.users.email, 'es@example.com'));
    });

    test('unverified email: no provisioning when IdP says false, linking refused unless verified + enabled', async () => {
      await setProvider({ linkByEmail: true });
      expectFailure(await flow({ email_verified: false }), 'email_unverified');
      // existing local account with the same email
      const [local] = await db.insert(schema.users).values({ username: 'jane', email: 'jane@example.com', displayName: 'Local Jane', passwordHash: bcryptHash }).returning();
      // IdP does not assert verification at all: refuse to link
      const noClaim = await flow({ email_verified: undefined });
      expectFailure(noClaim, 'email_unverified');
      expectFailure(await flow({ email_verified: false }), 'email_unverified');
      expect((await db.select().from(schema.userIdentities)).length).toBe(0);
      // verified + admin enabled: linked to the existing user, not duplicated
      const ok = await flow({ email_verified: true });
      expect(ok.location).toBe('/dashboard');
      const [ident] = await db.select().from(schema.userIdentities);
      expect(ident.userId).toBe(local.id);
      // linking disabled: refused even when verified
      await db.delete(schema.userIdentities);
      await setProvider({ linkByEmail: false });
      expectFailure(await flow({ email_verified: true }), 'account_exists');
      await db.delete(schema.users).where(eq(schema.users.id, local.id));
    });

    test('domain restriction applies to new and returning users', async () => {
      await setProvider({ allowedDomains: ['corp.example'] });
      expectFailure(await flow({ email: 'jane@example.com' }), 'domain_not_allowed');
      const ok = await flow({ email: 'jane@corp.example', sub: 'corp-sub' });
      expect(ok.location).toBe('/dashboard');
      // the IdP later asserts an outside email for the same subject
      expectFailure(await flow({ email: 'jane@other.example', sub: 'corp-sub' }), 'domain_not_allowed');
      await db.delete(schema.users).where(eq(schema.users.email, 'jane@corp.example'));
    });

    test('auto-provision disabled', async () => {
      await setProvider({ autoProvision: false });
      expectFailure(await flow({}), 'not_provisioned');
    });

    test('deactivated users cannot sign in via SSO', async () => {
      await setProvider();
      await flow({});
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.email, 'jane@example.com'));
      expectFailure(await flow({}), 'account_disabled');
    });

    test('IdP error parameter is surfaced as a fixed code', async () => {
      await setProvider();
      const res = await app.request('/rest/auth/1/oidc/fake/callback?error=access_denied&error_description=%3Cscript%3E');
      expect(res.headers.get('location')).toBe('/login?sso_error=idp_error');
    });
  });

  describe('enforce SSO', () => {
    test('password login refused for regular users, still open to system admins', async () => {
      await setProvider({ enforceSso: true });
      expect((await passwordLogin('plain')).res.status).toBe(401);
      expect((await passwordLogin('admin')).res.status).toBe(200);
      await setProvider({ enforceSso: false });
      expect((await passwordLogin('plain')).res.status).toBe(200);
    });
  });
  describe('licence and seats', () => {
    test('auto-provisioning refuses a new user at the seat limit, and existing identities keep signing in', async () => {
      await setProvider();
      expect((await flow({})).location).toBe('/dashboard'); // provisions jane
      const active = (await db.select().from(schema.users)).filter((u) => u.active !== false).length;
      await useTestLicense({ features: ['scim', 'sso_oidc_generic'], seats: active });
      // existing linked identity is unaffected
      expect((await flow({})).location).toBe('/dashboard');
      // a different subject would need a new seat
      expectFailure(await flow({ sub: 'someone-else', email: 'new.person@example.com' }), 'seat_limit');
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'new.person@example.com'))).length).toBe(0);
      await useTestLicense({ features: ['scim', 'sso_oidc_generic'], seats: active + 1 });
      expect((await flow({ sub: 'someone-else', email: 'new.person@example.com' })).location).toBe('/dashboard');
      await db.delete(schema.users).where(eq(schema.users.email, 'new.person@example.com'));
      await useTestLicense({ features: ['scim', 'sso_oidc_generic'] });
    });

    test('without the licence feature, auto-provisioning is refused but existing identities still sign in', async () => {
      await setProvider();
      await flow({});
      await useTestLicense(null); // community
      expect((await flow({})).location).toBe('/dashboard');
      expectFailure(await flow({ sub: 'x2', email: 'x2@example.com' }), 'licence_required');
      await useTestLicense({ features: ['scim', 'sso_oidc_generic'] });
    });
  });
});
