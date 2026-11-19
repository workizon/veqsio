import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { useTestLicense, clearTestLicense } from '../test-license';
import { createHash } from 'crypto';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { createSession } from '../../src/auth/session';

describe('SCIM 2.0', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let scimToken: string;
  let scimTokenId: number;

  const scim = (method: string, path: string, body?: unknown, token: string | null = scimToken, extra: Record<string, string> = {}) =>
    app.request(`/scim/v2${path}`, {
      method,
      headers: { 'Content-Type': 'application/scim+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const patchOps = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });
  const userBody = (userName: string, extra: Record<string, unknown> = {}) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, name: { givenName: 'Test', familyName: 'Person' },
    emails: [{ value: userName, primary: true, type: 'work' }], active: true, ...extra,
  });

  beforeAll(async () => {
    await resetRateLimits();
    await useTestLicense({ features: ['scim', 'sso_oidc_generic'] });
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    await db.delete(schema.scimTokens);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pw-123456' }) });
    adminCookie = login.headers.get('set-cookie') || '';
    const res = await app.request('/rest/api/2/admin/scim/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ name: 'okta' }) });
    expect(res.status).toBe(201);
    const created = await res.json();
    scimToken = created.token;
    scimTokenId = created.id;
  });

  afterAll(async () => {
    await clearTestLicense();
    await db.delete(schema.scimTokens);
    await resetTestDb(testSql);
    await testSql.end();
  });

  describe('token management and authentication', () => {
    test('token is shown once and only its hash is stored', async () => {
      expect(scimToken).toMatch(/^scim_[0-9a-f]{64}$/);
      const [row] = await db.select().from(schema.scimTokens).where(eq(schema.scimTokens.id, scimTokenId));
      expect(row.tokenHash).toBe(createHash('sha256').update(scimToken).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(scimToken);
      const list = await (await app.request('/rest/api/2/admin/scim/tokens', { headers: { Cookie: adminCookie } })).json();
      expect(JSON.stringify(list)).not.toContain(scimToken);
      expect(list[0].name).toBe('okta');
      expect(list[0].token).toBeUndefined();
    });

    test('token admin endpoints need a system admin session', async () => {
      expect((await app.request('/rest/api/2/admin/scim/tokens')).status).toBe(401);
      expect((await app.request('/rest/api/2/admin/scim/tokens', { headers: { Authorization: `Bearer ${scimToken}` } })).status).toBe(401);
    });

    test('rejects missing, wrong, and session-cookie authentication with SCIM error format', async () => {
      for (const res of [
        await scim('GET', '/Users', undefined, null),
        await scim('GET', '/Users', undefined, 'scim_' + '0'.repeat(64)),
        await scim('GET', '/Users', undefined, 'short'),
        await app.request('/scim/v2/Users', { headers: { Cookie: adminCookie } }),
      ]) {
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/scim+json');
        expect(res.headers.get('www-authenticate')).toContain('Bearer');
        const body = await res.json();
        expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
        expect(body.status).toBe('401');
      }
    });

    test('a personal access token is not a SCIM credential', async () => {
      const pat = 'veqsio_' + 'a'.repeat(64);
      const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin'));
      await db.insert(schema.personalAccessTokens).values({ userId: admin.id, name: 'x', tokenHash: createHash('sha256').update(pat).digest('hex'), scopes: ['*'] });
      expect((await scim('GET', '/Users', undefined, pat)).status).toBe(401);
    });

    test('revoked token stops working; last_used_at is recorded', async () => {
      const res = await app.request('/rest/api/2/admin/scim/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ name: 'tmp' }) });
      const { id, token } = await res.json();
      expect((await scim('GET', '/ServiceProviderConfig', undefined, token)).status).toBe(200);
      const [row] = await db.select().from(schema.scimTokens).where(eq(schema.scimTokens.id, id));
      expect(row.lastUsedAt).not.toBeNull();
      expect((await app.request(`/rest/api/2/admin/scim/tokens/${id}`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status).toBe(204);
      expect((await scim('GET', '/ServiceProviderConfig', undefined, token)).status).toBe(401);
    });
  });

  describe('discovery', () => {
    test('ServiceProviderConfig, Schemas, ResourceTypes', async () => {
      let res = await scim('GET', '/ServiceProviderConfig');
      expect(res.headers.get('content-type')).toContain('application/scim+json');
      const cfg = await res.json();
      expect(cfg.patch.supported).toBe(true);
      expect(cfg.bulk.supported).toBe(false);
      expect(cfg.filter.supported).toBe(true);
      res = await scim('GET', '/Schemas');
      expect((await res.json()).totalResults).toBe(2);
      res = await scim('GET', '/ResourceTypes');
      expect((await res.json()).Resources.map((r: any) => r.name).sort()).toEqual(['Group', 'User']);
      expect((await scim('GET', '/Nope')).status).toBe(404);
    });
  });

  describe('Users', () => {
    let id: string;

    test('create, conflict, get', async () => {
      let res = await scim('POST', '/Users', userBody('Alice@Corp.example', { externalId: 'ext-1' }));
      expect(res.status).toBe(201);
      expect(res.headers.get('location')).toContain('/scim/v2/Users/');
      const u = await res.json();
      id = u.id;
      expect(u).toMatchObject({ userName: 'alice@corp.example', externalId: 'ext-1', active: true });
      expect(u.emails[0].value).toBe('alice@corp.example');
      expect(u.name.givenName).toBe('Test');
      expect(u.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, Number(id)));
      expect(row.passwordHash).toBeNull();

      res = await scim('POST', '/Users', userBody('alice@corp.example'));
      expect(res.status).toBe(409);
      expect((await res.json()).scimType).toBe('uniqueness');

      res = await scim('GET', `/Users/${id}`);
      expect((await res.json()).id).toBe(id);
      expect((await scim('GET', '/Users/999999')).status).toBe(404);
      expect((await scim('GET', '/Users/abc')).status).toBe(404);
    });

    test('validation errors use the SCIM error format', async () => {
      let res = await scim('POST', '/Users', { userName: 'no-email' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
      expect(body.scimType).toBe('invalidValue');
      res = await app.request('/scim/v2/Users', { method: 'POST', headers: { Authorization: `Bearer ${scimToken}`, 'Content-Type': 'application/scim+json' }, body: '{not json' });
      expect(res.status).toBe(400);
      expect((await res.json()).scimType).toBe('invalidSyntax');
    });

    test('list with filter, pagination and no unknown-attribute injection', async () => {
      for (const n of ['bob@corp.example', 'carol@corp.example']) await scim('POST', '/Users', userBody(n));
      let body = await (await scim('GET', '/Users?filter=' + encodeURIComponent('userName eq "ALICE@corp.example"'))).json();
      expect(body.totalResults).toBe(1);
      expect(body.Resources[0].userName).toBe('alice@corp.example');
      expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);

      body = await (await scim('GET', '/Users?filter=' + encodeURIComponent('userName co "corp" and active eq true') + '&count=2&startIndex=1')).json();
      expect(body.totalResults).toBe(3);
      expect(body.itemsPerPage).toBe(2);
      expect(body.startIndex).toBe(1);
      const second = await (await scim('GET', '/Users?filter=' + encodeURIComponent('userName co "corp"') + '&count=2&startIndex=3')).json();
      expect(second.Resources.length).toBe(1);

      body = await (await scim('GET', '/Users?filter=' + encodeURIComponent('emails.value eq "bob@corp.example"'))).json();
      expect(body.totalResults).toBe(1);
      body = await (await scim('GET', '/Users?filter=' + encodeURIComponent('externalId eq "ext-1"'))).json();
      expect(body.Resources[0].userName).toBe('alice@corp.example');
      // wildcard characters are literals, quotes cannot break out
      body = await (await scim('GET', '/Users?filter=' + encodeURIComponent('userName sw "%"'))).json();
      expect(body.totalResults).toBe(0);
      body = await (await scim('GET', '/Users?filter=' + encodeURIComponent(`userName eq "x' or '1'='1"`))).json();
      expect(body.totalResults).toBe(0);

      const bad = await scim('GET', '/Users?filter=' + encodeURIComponent('password eq "x"'));
      expect(bad.status).toBe(400);
      expect((await bad.json()).scimType).toBe('invalidFilter');
      expect((await scim('GET', '/Users?filter=' + encodeURIComponent('userName eq'))).status).toBe(400);
      // count=0 returns only the total
      body = await (await scim('GET', '/Users?count=0')).json();
      expect(body.Resources).toEqual([]);
      expect(body.totalResults).toBe(4); // alice, bob, carol + the seeded admin
    });

    test('PUT replaces attributes', async () => {
      const res = await scim('PUT', `/Users/${id}`, userBody('alice@corp.example', { displayName: 'Alice A', externalId: 'ext-9', name: { givenName: 'Al', familyName: 'Ice' } }));
      expect(res.status).toBe(200);
      const u = await res.json();
      expect(u).toMatchObject({ displayName: 'Alice A', externalId: 'ext-9' });
      expect(u.name.givenName).toBe('Al');
      // renaming onto another user's userName conflicts
      expect((await scim('PUT', `/Users/${id}`, userBody('bob@corp.example'))).status).toBe(409);
      expect((await scim('PUT', '/Users/424242', userBody('zed@corp.example'))).status).toBe(404);
    });

    test('PATCH replace attributes and ignore unknown extension attributes', async () => {
      const res = await scim('PATCH', `/Users/${id}`, patchOps(
        { op: 'replace', path: 'displayName', value: 'Alice Patched' },
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'alice.new@corp.example' },
        { op: 'add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'R&D' },
      ));
      expect(res.status).toBe(200);
      const u = await res.json();
      expect(u.displayName).toBe('Alice Patched');
      expect(u.emails[0].value).toBe('alice.new@corp.example');
      expect((await scim('PATCH', `/Users/${id}`, { Operations: [{ op: 'remove', path: 'userName' }] })).status).toBe(400);
      expect((await scim('PATCH', `/Users/${id}`, {})).status).toBe(400);
    });

    test('deactivation via PATCH kills sessions and PATs; reactivation works', async () => {
      const [target] = await db.insert(schema.users).values({ username: 'victim', email: 'victim@corp.example', displayName: 'Victim', passwordHash: null }).returning();
      const sessionId = await createSession(target.id);
      const pat = 'veqsio_' + 'b'.repeat(64);
      await db.insert(schema.personalAccessTokens).values({ userId: target.id, name: 'v', tokenHash: createHash('sha256').update(pat).digest('hex'), scopes: ['*'] });
      const me = (cookie?: string, bearer?: string) => app.request('/rest/api/2/myself', { headers: { ...(cookie ? { Cookie: `session=${cookie}` } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
      expect((await me(sessionId)).status).toBe(200);
      expect((await me(undefined, pat)).status).toBe(200);

      // Entra style: string "False"
      const res = await scim('PATCH', `/Users/${target.id}`, patchOps({ op: 'Replace', path: 'active', value: 'False' }));
      expect(res.status).toBe(200);
      expect((await res.json()).active).toBe(false);

      expect((await me(sessionId)).status).toBe(401);
      expect((await me(undefined, pat)).status).toBe(401);
      const [tok] = await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.userId, target.id));
      expect(tok.revokedAt).not.toBeNull();
      // a brand new session for an inactive user is dead as well
      const fresh = await createSession(target.id);
      expect((await me(fresh)).status).toBe(401);

      // reactivation (Okta style, pathless object)
      const back = await scim('PATCH', `/Users/${target.id}`, patchOps({ op: 'replace', value: { active: true } }));
      expect((await back.json()).active).toBe(true);
      // old sessions stay dead; a new one works
      expect((await me(sessionId)).status).toBe(401);
      await new Promise((r) => setTimeout(r, 5));
      expect((await me(await createSession(target.id))).status).toBe(200);
    });

    test('DELETE deactivates instead of deleting', async () => {
      const created = await (await scim('POST', '/Users', userBody('dave@corp.example'))).json();
      const sessionId = await createSession(Number(created.id));
      const res = await scim('DELETE', `/Users/${created.id}`);
      expect(res.status).toBe(204);
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, Number(created.id)));
      expect(row).toBeDefined();
      expect(row.active).toBe(false);
      expect((await app.request('/rest/api/2/myself', { headers: { Cookie: `session=${sessionId}` } })).status).toBe(401);
      const got = await (await scim('GET', `/Users/${created.id}`)).json();
      expect(got.active).toBe(false);
      expect((await scim('DELETE', '/Users/999999')).status).toBe(404);
    });

    test('inactive users cannot log in with a password', async () => {
      const bcrypt = await import('bcryptjs');
      await db.insert(schema.users).values({ username: 'pwuser', email: 'pw@corp.example', displayName: 'PW', passwordHash: await bcrypt.hash('pw-123456', 4) });
      const login = () => app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwuser', password: 'pw-123456' }) });
      expect((await login()).status).toBe(200);
      const [u] = await db.select().from(schema.users).where(eq(schema.users.username, 'pwuser'));
      await scim('DELETE', `/Users/${u.id}`);
      expect((await login()).status).toBe(401);
    });
  });

  describe('Groups', () => {
    let gid: string;
    let u1: string, u2: string, u3: string;

    test('create with members, get, duplicate, unknown member', async () => {
      const ids: string[] = [];
      for (const n of ['g1@corp.example', 'g2@corp.example', 'g3@corp.example']) ids.push((await (await scim('POST', '/Users', userBody(n))).json()).id);
      [u1, u2, u3] = ids;
      let res = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Engineering', members: [{ value: u1 }] });
      expect(res.status).toBe(201);
      const g = await res.json();
      gid = g.id;
      expect(g.displayName).toBe('Engineering');
      expect(g.members.map((m: any) => m.value)).toEqual([u1]);
      expect((await scim('POST', '/Groups', { displayName: 'engineering' })).status).toBe(409);
      res = await scim('POST', '/Groups', { displayName: 'Ghosts', members: [{ value: '999999' }] });
      expect(res.status).toBe(400);
      expect((await db.select().from(schema.groups).where(eq(schema.groups.name, 'Ghosts'))).length).toBe(0);
      res = await scim('POST', '/Groups', { displayName: 'Ghosts', members: [{ value: 'abc' }] });
      expect(res.status).toBe(400);
      expect((await (await scim('GET', `/Groups/${gid}`)).json()).members.length).toBe(1);
    });

    test('list with filter', async () => {
      const body = await (await scim('GET', '/Groups?filter=' + encodeURIComponent('displayName eq "engineering"'))).json();
      expect(body.totalResults).toBe(1);
      expect(body.Resources[0].members.length).toBe(1);
      expect((await (await scim('GET', '/Groups?filter=' + encodeURIComponent('displayName eq "nope"'))).json()).totalResults).toBe(0);
    });

    test('PATCH add / remove members, rename', async () => {
      let res = await scim('PATCH', `/Groups/${gid}`, patchOps({ op: 'add', path: 'members', value: [{ value: u2 }, { value: u3 }] }));
      expect((await res.json()).members.map((m: any) => m.value).sort()).toEqual([u1, u2, u3].sort());
      res = await scim('PATCH', `/Groups/${gid}`, patchOps({ op: 'remove', path: `members[value eq "${u2}"]` }));
      expect((await res.json()).members.map((m: any) => m.value).sort()).toEqual([u1, u3].sort());
      res = await scim('PATCH', `/Groups/${gid}`, patchOps({ op: 'replace', path: 'displayName', value: 'Eng' }));
      expect((await res.json()).displayName).toBe('Eng');
      expect((await scim('PATCH', `/Groups/${gid}`, patchOps({ op: 'add', path: 'members', value: [{ value: '999999' }] }))).status).toBe(400);
    });

    test('PUT replaces members', async () => {
      const res = await scim('PUT', `/Groups/${gid}`, { displayName: 'Eng', members: [{ value: u2 }] });
      expect(res.status).toBe(200);
      expect((await res.json()).members.map((m: any) => m.value)).toEqual([u2]);
      const rows = await db.select().from(schema.userGroups).where(eq(schema.userGroups.groupId, Number(gid)));
      expect(rows.map((r) => r.userId)).toEqual([Number(u2)]);
    });

    test('PATCH remove all members, then DELETE', async () => {
      let res = await scim('PATCH', `/Groups/${gid}`, patchOps({ op: 'remove', path: 'members' }));
      expect((await res.json()).members).toEqual([]);
      res = await scim('DELETE', `/Groups/${gid}`);
      expect(res.status).toBe(204);
      expect((await scim('GET', `/Groups/${gid}`)).status).toBe(404);
      // users survive the group
      expect((await scim('GET', `/Users/${u1}`)).status).toBe(200);
    });
  });
});
