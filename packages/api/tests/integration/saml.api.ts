import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { useTestLicense, clearTestLicense } from '../test-license';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import { FakeSamlIdp, makeKeyPair } from '../fake-saml-idp';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { resetRateLimits } from '../reset-rate-limits';

const BASE = 'http://localhost';
const ACS = `${BASE}/rest/auth/1/saml/fake/acs`;
const SP_ENTITY = `${BASE}/rest/auth/1/saml/fake/metadata`;

describe('SAML 2.0 SSO', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let userCookie: string;
  let idp: FakeSamlIdp;
  let rogue: { privateKey: string; certificate: string };
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
    name: 'Fake SAML', slug: 'fake', idpEntityId: idp.entityId, idpSsoUrl: idp.ssoUrl, idpCertificates: idp.key.certificate,
    syncGroups: true, defaultGroups: [], allowedDomains: [], autoProvision: true, linkByEmail: false, enforceSso: false, enabled: true, ...over,
  });

  async function setProvider(over: Record<string, unknown> = {}) {
    await db.delete(schema.samlProviders);
    const res = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody(over));
    expect(res.status).toBe(201);
    return res.json();
  }

  async function begin(next?: string) {
    const res = await app.request(`/rest/auth/1/saml/fake/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    expect(res.status).toBe(302);
    const req = idp.parseRequest(res.headers.get('location')!);
    return { req, bind: cookieOf(res, 'saml_bind')!, res };
  }

  const post = (xml: string, s: { relay: string; bind?: string }, extra: Record<string, string> = {}) =>
    app.request('/rest/auth/1/saml/fake/acs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(s.bind ? { Cookie: `saml_bind=${s.bind}` } : {}), ...extra },
      body: new URLSearchParams({ SAMLResponse: FakeSamlIdp.b64(xml), RelayState: s.relay }).toString(),
    });

  /** Full flow; `build` receives the request details and returns the XML the IdP would post. */
  async function flow(build: (r: { id: string; acs: string }) => string, opts: { next?: string; omitBind?: boolean } = {}) {
    const s = await begin(opts.next);
    const xml = build({ id: s.req.id, acs: ACS });
    const res = await post(xml, { relay: s.req.relayState, bind: opts.omitBind ? undefined : s.bind });
    return { res, s, location: res.headers.get('location') ?? '', session: cookieOf(res, 'session') };
  }
  const ok = (over: Record<string, unknown> = {}) => (r: { id: string }) => idp.responseXml({ requestId: r.id, acsUrl: ACS, audience: SP_ENTITY, ...over });
  const expectFailure = (r: { location: string; session?: string }, code: string) => {
    expect(r.location).toBe(`/login?sso_error=${code}`);
    expect(r.session).toBeUndefined();
  };

  const savedEnv = { base: process.env.SAML_BASE_URL, auth: process.env.RATE_LIMIT_AUTH_MAX };
  beforeAll(async () => {
    process.env.SAML_BASE_URL = BASE; // independent of WEB_URL
    process.env.RATE_LIMIT_AUTH_MAX = '1000';
    await resetRateLimits();
    await useTestLicense({ features: ['sso_saml'] });
    [idp, rogue] = await Promise.all([makeKeyPair('fake-idp').then((k) => new FakeSamlIdp(k)), makeKeyPair('rogue')]);
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    bcryptHash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: bcryptHash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'plain', email: 'plain@example.com', displayName: 'Plain', passwordHash: bcryptHash });
    adminCookie = (await passwordLogin('admin')).cookie;
    userCookie = (await passwordLogin('plain')).cookie;
  });

  afterAll(async () => {
    if (savedEnv.base === undefined) delete process.env.SAML_BASE_URL; else process.env.SAML_BASE_URL = savedEnv.base;
    if (savedEnv.auth === undefined) delete process.env.RATE_LIMIT_AUTH_MAX; else process.env.RATE_LIMIT_AUTH_MAX = savedEnv.auth;
    await clearTestLicense();
    await db.delete(schema.samlProviders);
    await resetTestDb(testSql);
    await testSql.end();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await redis.del('veqsio:ratelimit:saml-acs:unknown', 'veqsio:ratelimit:saml-login:unknown');
    await db.delete(schema.users).where(eq(schema.users.email, 'jane@example.com'));
    await db.delete(schema.userIdentities);
    await db.delete(schema.groups).where(eq(schema.groups.description, 'Synced from Fake SAML'));
    await setProvider();
  });

  describe('admin API and metadata', () => {
    test('create validates certificates, never returns key material, needs a licence and SYSTEM_ADMIN', async () => {
      const bad = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ slug: 'bad-cert', idpCertificates: 'not a certificate' }));
      expect(bad.status).toBe(400);
      const http = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ slug: 'http-sso', idpSsoUrl: 'javascript:alert(1)' }));
      expect(http.status).toBe(400);
      expect((await json(userCookie, 'GET', '/rest/api/2/admin/saml')).status).toBe(403);
      expect((await app.request('/rest/api/2/admin/saml')).status).toBe(401);

      const withKey = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ slug: 'signed-sp', signRequests: true, spSigningKey: rogue.privateKey, spSigningCertificate: rogue.certificate }));
      expect(withKey.status).toBe(201);
      const body = await withKey.json();
      expect(body.hasSigningKey).toBe(true);
      expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
      const [row] = await db.select().from(schema.samlProviders).where(eq(schema.samlProviders.slug, 'signed-sp'));
      expect(row.spSigningKeyEncrypted!.startsWith('v1.')).toBe(true);
      expect(row.spSigningKeyEncrypted).not.toContain('PRIVATE KEY');
      const noKey = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ slug: 'sign-no-key', signRequests: true }));
      expect(noKey.status).toBe(400);

      await useTestLicense(null);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ slug: 'unlicensed' }))).status).toBe(402);
      const list = await (await json(adminCookie, 'GET', '/rest/api/2/admin/saml')).json();
      expect(list.length).toBe(2); // existing data stays readable
      const first = list[0];
      expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/saml/${first.id}`, { name: 'x' })).status).toBe(402);
      expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/saml/${first.id}`, { enabled: false })).status).toBe(200);
      expect((await json(adminCookie, 'POST', `/rest/api/2/admin/saml/${first.id}/test`)).status).toBe(402);
      await useTestLicense({ features: ['sso_saml'] });
      await db.delete(schema.samlProviders).where(eq(schema.samlProviders.slug, 'signed-sp'));
      await db.update(schema.samlProviders).set({ enabled: true });
    });

    test('metadata exposes the entity ID and ACS URL, test endpoint reports the certificates', async () => {
      const res = await app.request('/rest/auth/1/saml/fake/metadata');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('xml');
      const xml = await res.text();
      expect(xml).toContain(`entityID="${SP_ENTITY}"`);
      expect(xml).toContain(`Location="${ACS}"`);
      expect(xml).not.toContain('PRIVATE KEY');
      expect((await app.request('/rest/auth/1/saml/nope/metadata')).status).toBe(404);

      const [row] = await db.select().from(schema.samlProviders);
      const t = await (await json(adminCookie, 'POST', `/rest/api/2/admin/saml/${row.id}/test`)).json();
      expect(t.ok).toBe(true);
      expect(t.certificates[0].subject).toContain('fake-idp');
      expect(t.sp.acsUrl).toBe(ACS);
    });

    test('provider list is public and shows only enabled providers', async () => {
      const list = await (await app.request('/rest/auth/1/saml/providers')).json();
      expect(list).toEqual([{ name: 'Fake SAML', slug: 'fake' }]);
      await db.update(schema.samlProviders).set({ enabled: false });
      expect(await (await app.request('/rest/auth/1/saml/providers')).json()).toEqual([]);
      expect((await app.request('/rest/auth/1/saml/fake/login')).status).toBe(404);
    });

    test('signed AuthnRequests carry Signature and SigAlg', async () => {
      await db.delete(schema.samlProviders);
      const res = await json(adminCookie, 'POST', '/rest/api/2/admin/saml', providerBody({ signRequests: true, spSigningKey: rogue.privateKey, spSigningCertificate: rogue.certificate }));
      expect(res.status).toBe(201);
      const { req } = await begin();
      expect(req.signed).toBe(true);
      expect(req.sigAlg).toContain('rsa-sha256');
      const md = await (await app.request('/rest/auth/1/saml/fake/metadata')).text();
      expect(md).toContain('AuthnRequestsSigned="true"');
      expect(md).toContain('<ds:X509Certificate>');
    });
  });

  describe('login flow', () => {
    test('AuthnRequest uses the redirect binding with our entity, ACS and an opaque RelayState', async () => {
      const { req, res } = await begin('/browse/TEST-1');
      expect(req.url.origin + req.url.pathname).toBe(idp.ssoUrl);
      expect(req.destination).toBe(idp.ssoUrl);
      expect(req.acsUrl).toBe(ACS);
      expect(req.issuer).toBe(SP_ENTITY);
      expect(req.id).toMatch(/^_[0-9a-f]{32}$/);
      expect(req.relayState).not.toContain('browse'); // state is server-side
      expect(req.signed).toBe(false);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    test('happy path (signed assertion): provisions the user, issues a session cookie, audits the login', async () => {
      const r = await flow(ok({ groups: ['eng', 'ops'] }), { next: '/browse/TEST-1' });
      expect(r.location).toBe('/browse/TEST-1');
      expect(r.res.status).toBe(303);
      expect(r.session).toBeTruthy();
      const me = await app.request('/rest/api/2/myself', { headers: { Cookie: `session=${r.session}` } });
      expect(me.status).toBe(200);
      expect((await me.json()).emailAddress).toBe('jane@example.com');
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      expect(u.displayName).toBe('Jane Doe');
      expect(u.passwordHash).toBeNull();
      const [ident] = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, u.id));
      expect(ident.provider).toBe('saml:fake');
      await Bun.sleep(50);
      const audit = await json(adminCookie, 'GET', '/rest/api/2/admin/audit?action=SAML_LOGIN');
      expect(JSON.stringify(await audit.json())).toContain('SAML_LOGIN');
    });

    test('a signed Response with an unsigned assertion inside is accepted as well', async () => {
      const r = await flow(ok({ signAssertion: false, signResponse: true }));
      expect(r.location).toBe('/dashboard');
      expect(r.session).toBeTruthy();
    });

    test('a second login by the same user signs in the existing account (no duplicate)', async () => {
      await flow(ok());
      const r = await flow(ok());
      expect(r.location).toBe('/dashboard');
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(1);
    });

    test('the ACS accepts a cross-site form POST even with a session cookie (no CSRF refusal)', async () => {
      const s = await begin();
      const res = await post(ok()({ id: s.req.id }), { relay: s.req.relayState, bind: s.bind }, {
        Origin: 'https://idp.test', 'Sec-Fetch-Site': 'cross-site', Cookie: `saml_bind=${s.bind}; session=stale-session`,
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/dashboard');
    });

    test('open-redirect attempts in next fall back to the dashboard', async () => {
      for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
        const r = await flow(ok({ email: `u${Math.random().toString(16).slice(2, 8)}@example.com` }), { next });
        expect(r.location).toBe('/dashboard');
      }
    });
  });

  describe('JIT provisioning, linking and domains', () => {
    test('JIT off: unknown users are refused', async () => {
      await setProvider({ autoProvision: false });
      expectFailure(await flow(ok()), 'not_provisioned');
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(0);
    });

    test('allowed email domains are enforced', async () => {
      await setProvider({ allowedDomains: ['corp.example'] });
      expectFailure(await flow(ok({ email: 'jane@example.com' })), 'domain_not_allowed');
      expect((await flow(ok({ email: 'jane@corp.example' }))).location).toBe('/dashboard');
      await db.delete(schema.users).where(eq(schema.users.email, 'jane@corp.example'));
    });

    test('an existing local account is not taken over unless linking is enabled', async () => {
      expectFailure(await flow(ok({ email: 'plain@example.com' })), 'account_exists');
      await setProvider({ linkByEmail: true });
      const r = await flow(ok({ email: 'plain@example.com' }));
      expect(r.location).toBe('/dashboard');
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'plain@example.com'));
      expect((await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, u.id))).length).toBe(1);
    });

    test('a deactivated user cannot sign in', async () => {
      await flow(ok());
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.email, 'jane@example.com'));
      expectFailure(await flow(ok()), 'account_disabled');
    });

    test('transient NameIDs and missing e-mail are refused', async () => {
      expectFailure(await flow(ok({ nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', nameId: '_t1' })), 'nameid_transient');
      expectFailure(await flow(ok({ email: null, nameId: 'opaque-1', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' })), 'email_missing');
    });

    test('default groups are applied to JIT users (existing groups only)', async () => {
      const [g] = await db.insert(schema.groups).values({ name: 'saml-default-grp', description: 'manual' }).returning();
      await setProvider({ defaultGroups: ['saml-default-grp', 'does-not-exist'] });
      await flow(ok());
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      const mem = await db.select().from(schema.userGroups).where(eq(schema.userGroups.userId, u.id));
      expect(mem.map((m) => m.groupId)).toEqual([g.id]);
      await db.delete(schema.userGroups).where(eq(schema.userGroups.groupId, g.id));
      await db.delete(schema.groups).where(eq(schema.groups.id, g.id));
    });

    test('attribute mapping: explicit attribute names win, defaults cover common names', async () => {
      await setProvider({ emailAttribute: 'corp-mail', displayNameAttribute: 'full', usernameAttribute: 'login', syncGroups: true, groupsAttribute: 'roles2' });
      const r = await flow(ok({ email: null, nameId: 'subj-9', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', extraAttributes: { 'corp-mail': ['Mapped@Example.com'], full: ['Mapped Person'], login: ['mapped.p'], roles2: ['alpha'], email: ['wrong@example.com'] } }));
      expect(r.location).toBe('/dashboard');
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'mapped@example.com'));
      expect(u.username).toBe('mapped.p');
      expect(u.displayName).toBe('Mapped Person');
      await db.delete(schema.users).where(eq(schema.users.id, u.id));
    });
  });

  describe('group sync', () => {
    const groupsOf = async (email: string) => {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      const rows = await db.select({ name: schema.groups.name }).from(schema.userGroups).innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(eq(schema.userGroups.userId, u.id));
      return rows.map((r) => r.name).sort();
    };

    test('creates groups, adds memberships and only removes memberships the IdP itself added', async () => {
      await flow(ok({ groups: ['eng', 'ops'] }));
      expect(await groupsOf('jane@example.com')).toEqual(['eng', 'ops']);
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      const [manual] = await db.insert(schema.groups).values({ name: 'manual-only', description: 'by hand' }).returning();
      await db.insert(schema.userGroups).values({ userId: u.id, groupId: manual.id });

      await flow(ok({ groups: ['eng'] }));
      expect(await groupsOf('jane@example.com')).toEqual(['eng', 'manual-only']);
      await flow(ok({ groups: [] }));
      expect(await groupsOf('jane@example.com')).toEqual(['manual-only']);
      await db.delete(schema.userGroups).where(eq(schema.userGroups.groupId, manual.id));
      await db.delete(schema.groups).where(eq(schema.groups.id, manual.id));
    });

    test('with group sync off the assertion groups are ignored', async () => {
      await setProvider({ syncGroups: false });
      await flow(ok({ groups: ['eng'] }));
      expect(await groupsOf('jane@example.com')).toEqual([]);
    });
  });

  describe('rejections', () => {
    test('unsigned responses and assertions', async () => {
      expectFailure(await flow(ok({ signAssertion: false, signResponse: false })), 'saml_signature');
    });

    test('signed by a different key (wrong certificate)', async () => {
      expectFailure(await flow(ok({ key: rogue })), 'saml_signature');
    });

    test('a valid IdP certificate list accepts a rolled-over key', async () => {
      await setProvider({ idpCertificates: `${rogue.certificate}\n${idp.key.certificate}` });
      expect((await flow(ok())).location).toBe('/dashboard');
    });

    test('wrong audience, and a missing audience restriction', async () => {
      expectFailure(await flow(ok({ audience: 'https://other-sp.example/entity' })), 'saml_audience');
      expectFailure(await flow(ok({ omitAudience: true })), 'saml_audience');
    });

    test('wrong Recipient and wrong Destination', async () => {
      expectFailure(await flow(ok({ recipient: 'https://evil.example/acs' })), 'saml_recipient');
      expectFailure(await flow(ok({ signResponse: true, destination: 'https://evil.example/acs' })), 'saml_destination');
    });

    test('expired and not-yet-valid assertions, with at most 2 minutes of clock skew', async () => {
      expectFailure(await flow(ok({ notOnOrAfter: -10 * 60_000 })), 'saml_assertion_expired');
      expectFailure(await flow(ok({ notBefore: 10 * 60_000 })), 'saml_assertion_expired');
      expect((await flow(ok({ notBefore: 60_000 }))).location).toBe('/dashboard'); // within skew
      expectFailure(await flow(ok({ notBefore: 3 * 60_000 })), 'saml_assertion_expired'); // beyond skew
      expectFailure(await flow(ok({ notOnOrAfter: -3 * 60_000 })), 'saml_assertion_expired');
    });

    test('wrong InResponseTo and unsolicited (IdP-initiated) responses', async () => {
      expectFailure(await flow((r) => ok({ requestId: `${r.id}x` })(r)), 'saml_in_response_to');
      expectFailure(await flow((r) => ok({ requestId: '_somebody_elses_request' })(r)), 'saml_in_response_to');
      expectFailure(await flow((r) => ok({ requestId: null })(r)), 'saml_in_response_to');
    });

    test('wrong issuer', async () => {
      expectFailure(await flow(ok({ issuer: 'https://evil-idp.example/entity' })), 'saml_issuer');
    });

    test('a response can be used only once (state is single use) and cannot be replayed on a new flow', async () => {
      const s = await begin();
      const xml = ok()({ id: s.req.id });
      const first = await post(xml, { relay: s.req.relayState, bind: s.bind });
      expect(first.headers.get('location')).toBe('/dashboard');
      const again = await post(xml, { relay: s.req.relayState, bind: s.bind });
      expect(again.headers.get('location')).toBe('/login?sso_error=invalid_state');
      expect(cookieOf(again, 'session')).toBeUndefined();
      // replaying it against a fresh login attempt: InResponseTo names another request
      const s2 = await begin();
      const replay = await post(xml, { relay: s2.req.relayState, bind: s2.bind });
      expect(replay.headers.get('location')).toMatch(/^\/login\?sso_error=saml_(in_response_to|replayed)$/);
      expect(cookieOf(replay, 'session')).toBeUndefined();
    });

    test('unknown, mismatched and malformed RelayState; browser binding mismatch', async () => {
      const s = await begin();
      const xml = ok()({ id: s.req.id });
      for (const relay of ['', 'x'.repeat(40), 'short', 'a'.repeat(300)]) {
        const res = await post(xml, { relay, bind: s.bind });
        expect(res.headers.get('location')).toMatch(/^\/login\?sso_error=(invalid_state|invalid_request)$/);
      }
      const bad = await post(xml, { relay: s.req.relayState, bind: 'someone-elses-cookie' });
      expect(bad.headers.get('location')).toBe('/login?sso_error=invalid_state');
      expect(cookieOf(bad, 'session')).toBeUndefined();
      // the state was consumed by the failed attempt
      expect((await post(xml, { relay: s.req.relayState, bind: s.bind })).headers.get('location')).toBe('/login?sso_error=invalid_state');
    });

    test('a response for provider A is refused at provider B', async () => {
      const s = await begin();
      await db.insert(schema.samlProviders).values({ name: 'B', slug: 'other', idpEntityId: idp.entityId, idpSsoUrl: idp.ssoUrl, idpCertificates: idp.key.certificate });
      const res = await app.request('/rest/auth/1/saml/other/acs', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `saml_bind=${s.bind}` },
        body: new URLSearchParams({ SAMLResponse: FakeSamlIdp.b64(ok()({ id: s.req.id })), RelayState: s.req.relayState }).toString(),
      });
      expect(res.headers.get('location')).toBe('/login?sso_error=invalid_state');
      await db.delete(schema.samlProviders).where(eq(schema.samlProviders.slug, 'other'));
    });

    test('malformed request shapes', async () => {
      const post2 = (body: string, ct = 'application/x-www-form-urlencoded') => app.request('/rest/auth/1/saml/fake/acs', { method: 'POST', headers: { 'Content-Type': ct }, body });
      expect((await post2('foo=bar')).headers.get('location')).toBe('/login?sso_error=invalid_request');
      expect((await post2('{"SAMLResponse":"x"}', 'application/json')).headers.get('location')).toBe('/login?sso_error=invalid_request');
      const s = await begin();
      const garbage = await post2(new URLSearchParams({ SAMLResponse: '!!!not-base64!!!', RelayState: s.req.relayState }).toString());
      expect(garbage.headers.get('location')).toBe('/login?sso_error=saml_invalid_request');
      expect((await app.request('/rest/auth/1/saml/nope/acs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'SAMLResponse=a&RelayState=b' })).headers.get('location')).toBe('/login?sso_error=unknown_provider');
    });

    test('is rate limited per client', async () => {
      process.env.RATE_LIMIT_AUTH_MAX = '3';
      try {
        let limited = 0;
        for (let i = 0; i < 6; i++) {
          const res = await app.request('/rest/auth/1/saml/fake/acs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'SAMLResponse=a&RelayState=b' });
          if (res.headers.get('location') === '/login?sso_error=rate_limited') limited++;
        }
        expect(limited).toBeGreaterThanOrEqual(3);
      } finally {
        process.env.RATE_LIMIT_AUTH_MAX = '1000';
      }
    });
  });

  describe('XML attacks', () => {
    const attack = async (xml: string) => {
      const s = await begin();
      const res = await post(xml, { relay: s.req.relayState, bind: s.bind });
      return { location: res.headers.get('location') ?? '', session: cookieOf(res, 'session'), status: res.status };
    };
    const noUser = async () => expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(0);

    test('DOCTYPE / external entity (XXE) is refused before parsing', async () => {
      const s = await begin();
      const valid = ok()({ id: s.req.id });
      const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>${valid.replace('<saml:Issuer>', '<saml:Issuer>&x;')}`;
      const res = await post(xxe, { relay: s.req.relayState, bind: s.bind });
      expect(res.headers.get('location')).toBe('/login?sso_error=saml_dtd_forbidden');
      await noUser();
    });

    test('billion laughs and quadratic blowup payloads are refused cheaply', async () => {
      const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">&lol3;</samlp:Response>`;
      const t0 = Date.now();
      expect((await attack(laughs)).location).toBe('/login?sso_error=saml_dtd_forbidden');
      expect(Date.now() - t0).toBeLessThan(2000);
      const undeclared = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">&lol3;</samlp:Response>`;
      expect((await attack(undeclared)).location).toBe('/login?sso_error=saml_dtd_forbidden');
    });

    test('oversized payloads are refused (413 at the HTTP layer, size cap in the decoder)', async () => {
      const big = 'A'.repeat(700 * 1024);
      const res = await app.request('/rest/auth/1/saml/fake/acs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: big, RelayState: 'x'.repeat(30) }).toString() });
      expect(res.status).toBe(413);
      const medium = 'A'.repeat(515 * 1024);
      const s = await begin();
      const r2 = await app.request('/rest/auth/1/saml/fake/acs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `saml_bind=${s.bind}` }, body: new URLSearchParams({ SAMLResponse: medium, RelayState: s.req.relayState }).toString() });
      expect(r2.headers.get('location')).toBe('/login?sso_error=saml_payload_too_large');
    });

    test('processing instructions, deep nesting and non-UTF-8 documents are refused', async () => {
      const s = await begin();
      const valid = ok()({ id: s.req.id });
      expect((await attack(`${valid}<?evil payload?>`)).location).toBe('/login?sso_error=saml_invalid_xml');
      expect((await attack(`<a>`.repeat(200) + `</a>`.repeat(200))).location).toBe('/login?sso_error=saml_invalid_xml');
      const utf16 = Buffer.from(valid, 'utf16le').toString('base64');
      const s2 = await begin();
      const res = await app.request('/rest/auth/1/saml/fake/acs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `saml_bind=${s2.bind}` }, body: new URLSearchParams({ SAMLResponse: utf16, RelayState: s2.req.relayState }).toString() });
      expect(res.headers.get('location')).toBe('/login?sso_error=saml_invalid_xml');
    });

    test('signature wrapping: forged assertion in the expected place, genuine signed one hidden elsewhere', async () => {
      const s = await begin();
      const o = { requestId: s.req.id, acsUrl: ACS, audience: SP_ENTITY };
      const genuine = idp.signedAssertion({ ...o, email: 'admin@example.com' }); // validly signed, but for somebody else
      const forged = idp.assertionXml({ ...o, email: 'jane@example.com' }, '_forged1').replace('</saml:Issuer>', `</saml:Issuer><saml:Advice>${genuine}</saml:Advice>`);
      const xml = idp.responseXml({ ...o, signAssertion: false }, forged);
      const res = await post(xml, { relay: s.req.relayState, bind: s.bind });
      expect(res.headers.get('location')).toBe('/login?sso_error=saml_signature');
      expect(cookieOf(res, 'session')).toBeUndefined();
      await noUser();
    });

    test('signature wrapping: unsigned forged assertion next to the genuine signed one', async () => {
      const s = await begin();
      const o = { requestId: s.req.id, acsUrl: ACS, audience: SP_ENTITY };
      const genuine = idp.signedAssertion({ ...o, email: 'plain@example.com' });
      const forged = idp.assertionXml({ ...o, email: 'jane@example.com' }, '_forged2');
      for (const inner of [`${forged}${genuine}`, `${genuine}${forged}`]) {
        const s3 = await begin();
        const xml = idp.responseXml({ ...o, requestId: s3.req.id, signAssertion: false }, inner.replaceAll(s.req.id, s3.req.id));
        const res = await post(xml, { relay: s3.req.relayState, bind: s3.bind });
        expect(res.headers.get('location')).toBe('/login?sso_error=saml_signature');
        expect(cookieOf(res, 'session')).toBeUndefined();
      }
      await noUser();
    });

    test('signature wrapping: content changed after signing (assertion and response level)', async () => {
      const s1 = await begin();
      const signed = idp.responseXml({ requestId: s1.req.id, acsUrl: ACS, audience: SP_ENTITY, email: 'plain@example.com' });
      const r1 = await post(signed.replace('plain@example.com', 'jane@example.com'), { relay: s1.req.relayState, bind: s1.bind });
      expect(r1.headers.get('location')).toBe('/login?sso_error=saml_signature');

      const s2 = await begin();
      const whole = idp.responseXml({ requestId: s2.req.id, acsUrl: ACS, audience: SP_ENTITY, email: 'plain@example.com', signAssertion: false, signResponse: true });
      const extra = idp.assertionXml({ requestId: s2.req.id, acsUrl: ACS, audience: SP_ENTITY, email: 'jane@example.com' }, '_forged3');
      const r2 = await post(whole.replace('</samlp:Response>', `${extra}</samlp:Response>`), { relay: s2.req.relayState, bind: s2.bind });
      expect(r2.headers.get('location')).toBe('/login?sso_error=saml_signature');

      const s3 = await begin();
      const sig = idp.responseXml({ requestId: s3.req.id, acsUrl: ACS, audience: SP_ENTITY, email: 'plain@example.com', signAssertion: false, signResponse: true });
      const r3 = await post(sig.replace('<saml:Issuer>', '<saml:Issuer>x'), { relay: s3.req.relayState, bind: s3.bind });
      expect(r3.headers.get('location')).toMatch(/^\/login\?sso_error=saml_/);
      await noUser();
    });

    test('attributes are read only from the signed assertion (a decoy in an unsigned part is ignored)', async () => {
      const s = await begin();
      const o = { requestId: s.req.id, acsUrl: ACS, audience: SP_ENTITY, email: 'jane@example.com' };
      // The Response is signed as a whole. A decoy Assertion in an Extensions-like wrapper placed BEFORE signing is
      // part of the digest, so it is signed as well but never read: only /Response/Assertion is evaluated.
      const base = idp.responseXml({ ...o, signAssertion: false });
      const decoy = `<saml:Advice>${idp.assertionXml({ ...o, email: 'plain@example.com' }, '_decoy')}</saml:Advice>`;
      const inner = idp.assertionXml(o, `_real${Math.random().toString(16).slice(2)}`).replace('</saml:Issuer>', `</saml:Issuer>${decoy}`);
      const xml = idp.responseXml({ ...o, signAssertion: false, signResponse: true }, inner);
      expect(base).toBeTruthy();
      const res = await post(xml, { relay: s.req.relayState, bind: s.bind });
      expect(res.headers.get('location')).toBe('/dashboard');
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'));
      expect(u).toBeTruthy();
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'plain@example.com'))).length).toBe(1); // unchanged, no extra identity
      expect((await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.providerUserId, 'plain@example.com'))).length).toBe(0);
    });
  });

  describe('SSO enforcement and logging', () => {
    test('enforce SSO blocks password login for covered users but not for system administrators', async () => {
      expect((await passwordLogin('plain')).res.status).toBe(200);
      await db.update(schema.samlProviders).set({ enforceSso: true });
      expect((await passwordLogin('plain')).res.status).toBe(401);
      expect((await passwordLogin('admin')).res.status).toBe(200);
      await db.update(schema.samlProviders).set({ allowedDomains: ['corp.example'] });
      expect((await passwordLogin('plain')).res.status).toBe(200); // domain not covered
      await db.update(schema.samlProviders).set({ enforceSso: false, allowedDomains: [] });
    });

    test('assertions and responses are never written to the log', async () => {
      const lines: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      try {
        await flow(ok({ signAssertion: false, signResponse: false, email: 'secret-person@example.com' }));
      } finally {
        console.warn = orig;
      }
      const log = lines.join('\n');
      expect(log).toContain('SAML login failed');
      expect(log).not.toContain('secret-person');
      expect(log).not.toContain('<saml');
      expect(log).not.toContain('PHNhbWw');
    });
  });
});
