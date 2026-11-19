import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { useTestLicense, clearTestLicense } from '../test-license';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import { FakeLdap } from '../fake-ldap';
import * as schema from '@veqsio/db';
import { and, eq, like } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { authenticateAgainst, runDueDirectorySyncs, setLdapClientFactoryForTests } from '../../src/auth/ldap-service';

describe('LDAP / Active Directory', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let userCookie: string;
  let bcryptHash: string;
  let dirId = 0;
  const ldap = new FakeLdap();

  const json = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string, password: string) => {
    const res = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return { res, cookie: res.headers.get('set-cookie') || '' };
  };

  const dirBody = (over: Record<string, unknown> = {}) => ({
    name: 'Fake LDAP', url: 'ldap://ldap.test:389', startTls: false, bindDn: ldap.serviceDn, bindPassword: ldap.servicePassword,
    baseDn: 'ou=people,dc=example,dc=com', userFilter: '(objectClass=inetOrgPerson)', groupBaseDn: 'ou=groups,dc=example,dc=com',
    autoProvision: true, loginEnabled: true, syncEnabled: false, ...over,
  });
  async function setDirectory(over: Record<string, unknown> = {}) {
    await db.delete(schema.ldapDirectories);
    const res = await json(adminCookie, 'POST', '/rest/api/2/admin/ldap', dirBody(over));
    expect(res.status).toBe(201);
    dirId = (await res.json()).id;
  }
  const patchDir = async (over: Record<string, unknown>) => { expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/ldap/${dirId}`, over)).status).toBe(200); };
  const sync = async (body: Record<string, unknown> = { dryRun: false }) => {
    const res = await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/sync`, body);
    return { status: res.status, body: await res.json() };
  };
  const userByEmail = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
  const groupsOf = async (email: string) => {
    const u = await userByEmail(email);
    const rows = await db.select({ name: schema.groups.name }).from(schema.userGroups).innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(eq(schema.userGroups.userId, u.id));
    return rows.map((r) => r.name).sort();
  };

  const seedDirectory = () => {
    ldap.entries = [];
    const jane = ldap.addUser('jane', { cn: 'Jane Doe' });
    const joe = ldap.addUser('joe', { cn: 'Joe Bloggs' });
    const kim = ldap.addUser('kim');
    ldap.addGroup('eng', [jane, joe]);
    ldap.addGroup('ops', [kim]);
    return { jane, joe, kim };
  };

  beforeAll(async () => {
    await resetRateLimits();
    await useTestLicense({ features: ['ldap'] });
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    bcryptHash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: bcryptHash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'plain', email: 'plain@example.com', displayName: 'Plain', passwordHash: bcryptHash });
    adminCookie = (await login('admin', 'pw-123456')).cookie;
    userCookie = (await login('plain', 'pw-123456')).cookie;
    setLdapClientFactoryForTests(ldap.factory);
  });

  afterAll(async () => {
    setLdapClientFactoryForTests(null);
    await clearTestLicense();
    await db.delete(schema.ldapDirectories);
    await resetTestDb(testSql);
    await testSql.end();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await useTestLicense({ features: ['ldap'] });
    ldap.down = false;
    ldap.allowEmptyPasswordBind = true;
    ldap.searches = [];
    ldap.binds = [];
    seedDirectory();
    await db.delete(schema.userIdentities).where(like(schema.userIdentities.provider, 'ldap:%'));
    await db.delete(schema.users).where(like(schema.users.email, '%@example.com'));
    await db.insert(schema.users).values({ username: 'plain', email: 'plain@example.com', displayName: 'Plain', passwordHash: bcryptHash });
    await db.delete(schema.groups).where(like(schema.groups.description, 'Synced from%'));
    await setDirectory();
    userCookie = (await login('plain', 'pw-123456')).cookie;
  });

  describe('admin API', () => {
    test('validates input, encrypts the bind password, never returns it, needs a licence and SYSTEM_ADMIN', async () => {
      const bad = [
        { url: 'http://ldap.test' }, { url: 'ldap://user:pw@ldap.test' }, { url: 'ldaps://ldap.test', startTls: true },
        { userFilter: 'objectClass=person' }, { userFilter: '(objectClass=person' }, { userFilter: '(a=b)(c=d)' }, { usernameAttribute: 'uid)(x' },
        { maxEntries: 10_000_000 }, { bindPassword: '' },
      ];
      for (const over of bad) expect((await json(adminCookie, 'POST', '/rest/api/2/admin/ldap', dirBody(over))).status).toBe(400);
      const [row] = await db.select().from(schema.ldapDirectories);
      expect(row.bindPasswordEncrypted.startsWith('v1.')).toBe(true);
      expect(row.bindPasswordEncrypted).not.toContain(ldap.servicePassword);
      const list = await (await json(adminCookie, 'GET', '/rest/api/2/admin/ldap')).json();
      expect(JSON.stringify(list)).not.toContain(ldap.servicePassword);
      expect(list[0].hasBindPassword).toBe(true);
      expect(list[0].bindPassword).toBeUndefined();
      expect(list[0].bindPasswordEncrypted).toBeUndefined();
      expect((await json(userCookie, 'GET', '/rest/api/2/admin/ldap')).status).toBe(403);
      expect((await app.request('/rest/api/2/admin/ldap')).status).toBe(401);
      expect((await json(userCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/sync`, { dryRun: true })).status).toBe(403);

      const put = await json(adminCookie, 'PUT', `/rest/api/2/admin/ldap/${dirId}`, { name: 'Renamed', bindPassword: 'new-secret' });
      expect(put.status).toBe(200);
      const [after] = await db.select().from(schema.ldapDirectories);
      expect(after.bindPasswordEncrypted).not.toBe(row.bindPasswordEncrypted);

      await useTestLicense(null);
      expect((await json(adminCookie, 'POST', '/rest/api/2/admin/ldap', dirBody())).status).toBe(402);
      expect((await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/test`)).status).toBe(402);
      expect((await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/sync`, { dryRun: true })).status).toBe(402);
      expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/ldap/${dirId}`, { name: 'x' })).status).toBe(402);
      expect((await json(adminCookie, 'GET', '/rest/api/2/admin/ldap')).status).toBe(200); // data stays readable
      expect((await json(adminCookie, 'PUT', `/rest/api/2/admin/ldap/${dirId}`, { enabled: false })).status).toBe(200);
    });

    test('test connection reports users and groups, bind failures and outages', async () => {
      const ok = await (await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/test`)).json();
      expect(ok).toMatchObject({ ok: true, users: 3, groups: 2 });
      ldap.servicePassword = 'rotated';
      const bad = await (await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/test`)).json();
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('bind');
      expect(JSON.stringify(bad)).not.toContain('rotated');
      ldap.servicePassword = 'svc-secret';
      ldap.down = true;
      const down = await (await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/test`)).json();
      expect(down.ok).toBe(false);
      expect(down.error).toContain('connect');
    });

    test('the connection settings reach the client (StartTLS, certificate checking, timeout)', async () => {
      await setDirectory({ startTls: true, tlsRejectUnauthorized: true, timeoutMs: 3000 });
      ldap.configs = [];
      await json(adminCookie, 'POST', `/rest/api/2/admin/ldap/${dirId}/test`);
      expect(ldap.configs[0]).toMatchObject({ url: 'ldap://ldap.test:389', startTls: true, tlsRejectUnauthorized: true, timeoutMs: 3000 });
    });
  });

  describe('password login', () => {
    test('JIT provisions a directory user on first login, then reuses the account', async () => {
      const r = await login('jane', 'pw-jane');
      expect(r.res.status).toBe(200);
      const u = await userByEmail('jane@example.com');
      expect(u.displayName).toBe('Jane Doe');
      expect(u.passwordHash).toBeNull();
      const me = await app.request('/rest/api/2/myself', { headers: { Cookie: r.cookie } });
      expect((await me.json()).emailAddress).toBe('jane@example.com');
      const [ident] = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, u.id));
      expect(ident.provider).toBe(`ldap:${dirId}`);
      expect(ident.providerUserId).toBe('uuid-jane');
      expect((await login('jane', 'pw-jane')).res.status).toBe(200);
      expect((await db.select().from(schema.users).where(eq(schema.users.email, 'jane@example.com'))).length).toBe(1);
      expect(await groupsOf('jane@example.com')).toEqual(['eng']);
    });

    test('wrong password, unknown user and JIT off are refused', async () => {
      expect((await login('jane', 'wrong')).res.status).toBe(401);
      expect((await login('nobody', 'x')).res.status).toBe(401);
      expect(await userByEmail('jane@example.com')).toBeUndefined();
      await setDirectory({ autoProvision: false });
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
      expect(await userByEmail('jane@example.com')).toBeUndefined();
    });

    test('empty passwords never log in, even on a server that accepts unauthenticated binds', async () => {
      ldap.allowEmptyPasswordBind = true;
      for (const body of [{ username: 'jane', password: '' }, { username: 'jane', password: null }, { username: '', password: 'x' }]) {
        const res = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(400);
      }
      const [dir] = await db.select().from(schema.ldapDirectories);
      ldap.binds = [];
      expect(await authenticateAgainst(dir, 'jane', '')).toBeNull();
      expect(await authenticateAgainst(dir, 'jane', 'a\u0000b')).toBeNull();
      expect(ldap.binds.filter((b) => b.dn.startsWith('uid=jane'))).toEqual([]); // no bind as the user was even attempted
    });

    test('LDAP filter injection through the username finds nothing and is escaped', async () => {
      const payloads = ['*', 'jane)(uid=*', '*)(objectClass=*', 'jane*', '\\2a', 'jane\u0000', ')(|(uid=*'];
      for (const p of payloads) expect([400, 401]).toContain((await login(p, 'pw-jane')).res.status);
      for (const s of ldap.searches.filter((x) => x.base === 'ou=people,dc=example,dc=com' && x.filter.startsWith('(&'))) {
        expect(s.filter).not.toContain('uid=*');
        expect(s.filter).not.toMatch(/\(uid=[^)]*[^\\]\)\(/);
      }
      expect(await userByEmail('jane@example.com')).toBeUndefined();
      expect(await userByEmail('joe@example.com')).toBeUndefined();
    });

    test('an ambiguous login (two entries) is refused', async () => {
      ldap.addUser('jane', { id: 'uuid-jane-2', mail: 'jane2@example.com' });
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
    });

    test('a local user that is not linked keeps local-only authentication (no takeover by username)', async () => {
      ldap.addUser('plain', { password: 'directory-pw', mail: 'plain-ldap@example.com' });
      expect((await login('plain', 'pw-123456')).res.status).toBe(200);
      expect((await login('plain', 'directory-pw')).res.status).toBe(401);
    });

    test('a user linked to the directory authenticates against the directory only', async () => {
      const u = await userByEmail('plain@example.com');
      await db.insert(schema.userIdentities).values({ userId: u.id, provider: `ldap:${dirId}`, providerUserId: 'uuid-plain', email: u.email, rawProfile: { syncedGroups: [], ldapLogin: 'plainldap' } });
      ldap.addUser('plainldap', { id: 'uuid-plain', password: 'directory-pw', mail: 'plain@example.com' });
      expect((await login('plain', 'pw-123456')).res.status).toBe(401); // local password no longer counts
      expect((await login('plain', 'directory-pw')).res.status).toBe(200);
      ldap.entries.find((e) => e.attrs.uid?.[0] === 'plainldap')!.attrs.entryUUID = ['someone-else'];
      expect((await login('plain', 'directory-pw')).res.status).toBe(401); // the login now belongs to another entry
    });

    test('link by email is opt-in', async () => {
      ldap.addUser('plainldap', { password: 'directory-pw', mail: 'plain@example.com' });
      expect((await login('plainldap', 'directory-pw')).res.status).toBe(401);
      await patchDir({ linkByEmail: true });
      expect((await login('plainldap', 'directory-pw')).res.status).toBe(200);
      const u = await userByEmail('plain@example.com');
      expect((await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, u.id))).length).toBe(1);
    });

    test('deactivated users, directory outages and a missing licence', async () => {
      await login('jane', 'pw-jane');
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.email, 'jane@example.com'));
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
      await db.update(schema.users).set({ active: true }).where(eq(schema.users.email, 'jane@example.com'));
      ldap.down = true;
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
      expect((await login('plain', 'pw-123456')).res.status).toBe(200); // local accounts are unaffected
      ldap.down = false;
      await useTestLicense(null);
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
      await useTestLicense({ features: ['ldap'] });
      expect((await login('jane', 'pw-jane')).res.status).toBe(200);
    });

    test('login syncs direct groups and removes only groups this directory added', async () => {
      await login('jane', 'pw-jane');
      const u = await userByEmail('jane@example.com');
      const [manual] = await db.insert(schema.groups).values({ name: 'manual-grp', description: 'by hand' }).returning();
      await db.insert(schema.userGroups).values({ userId: u.id, groupId: manual.id });
      ldap.entries = ldap.entries.filter((e) => e.attrs.cn[0] !== 'eng');
      ldap.addGroup('ops', [`uid=jane,ou=people,dc=example,dc=com`]);
      await login('jane', 'pw-jane');
      expect(await groupsOf('jane@example.com')).toEqual(['manual-grp', 'ops']);
      await db.delete(schema.userGroups).where(eq(schema.userGroups.groupId, manual.id));
      await db.delete(schema.groups).where(eq(schema.groups.id, manual.id));
    });

    test('enforced SAML SSO also covers directory password logins (system administrators stay exempt)', async () => {
      await login('jane', 'pw-jane');
      await useTestLicense({ features: ['ldap', 'sso_saml'] });
      await db.insert(schema.samlProviders).values({ name: 'E', slug: 'enf', idpEntityId: 'x', idpSsoUrl: 'https://i.test/sso', idpCertificates: 'x', enforceSso: true });
      expect((await login('jane', 'pw-jane')).res.status).toBe(401);
      expect((await login('admin', 'pw-123456')).res.status).toBe(200);
      await db.delete(schema.samlProviders);
    });
  });

  describe('sync', () => {
    test('dry run shows exact counts and changes nothing', async () => {
      const before = (await db.select().from(schema.users)).length;
      const r = await sync({ dryRun: true });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.counts).toMatchObject({ directoryUsers: 3, create: 3, deactivate: 0, groupsCreate: 2, membershipsAdd: 3, skipped: 0 });
      expect(r.body.groupsToCreate).toEqual(['eng', 'ops']);
      expect((await db.select().from(schema.users)).length).toBe(before);
      expect((await db.select().from(schema.groups).where(eq(schema.groups.name, 'eng'))).length).toBe(0);
      const [d] = await db.select().from(schema.ldapDirectories);
      expect(d.lastSyncAt).toBeNull();
    });

    test('creates users and groups, is idempotent, updates changed attributes', async () => {
      const first = await sync();
      expect(first.body.counts).toMatchObject({ create: 3, groupsCreate: 2, membershipsAdd: 3 });
      expect(await groupsOf('jane@example.com')).toEqual(['eng']);
      expect((await userByEmail('joe@example.com')).displayName).toBe('Joe Bloggs');
      const again = (await sync({ dryRun: true })).body;
      expect(again.counts).toMatchObject({ create: 0, update: 0, deactivate: 0, reactivate: 0, membershipsAdd: 0, membershipsRemove: 0, groupsCreate: 0 });
      ldap.entries.find((e) => e.attrs.uid[0] === 'joe')!.attrs.cn = ['Joseph Bloggs'];
      const upd = await sync();
      expect(upd.body.counts.update).toBe(1);
      expect((await userByEmail('joe@example.com')).displayName).toBe('Joseph Bloggs');
      const [d] = await db.select().from(schema.ldapDirectories);
      expect(d.lastSyncAt).not.toBeNull();
      expect((d.lastSyncResult as any).ok).toBe(true);
    });

    test('users that disappear are deactivated (never deleted), sessions end, and they come back when they reappear', async () => {
      await sync();
      const jane = await login('jane', 'pw-jane');
      expect(jane.res.status).toBe(200);
      ldap.remove('jane');
      const r = await sync();
      expect(r.body.counts.deactivate).toBe(1);
      const u = await userByEmail('jane@example.com');
      expect(u).toBeTruthy();
      expect(u.active).toBe(false);
      expect((await app.request('/rest/api/2/myself', { headers: { Cookie: jane.cookie } })).status).toBe(401);
      ldap.addUser('jane', { cn: 'Jane Doe' });
      const back = await sync();
      expect(back.body.counts.reactivate).toBe(1);
      expect((await userByEmail('jane@example.com')).active).toBe(true);
    });

    test('an administrator deactivation is not undone by the sync', async () => {
      await sync();
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.email, 'kim@example.com'));
      const r = await sync();
      expect(r.body.skipped).toContainEqual({ key: 'uuid-kim', reason: 'deactivated_manually' });
      expect((await userByEmail('kim@example.com')).active).toBe(false);
    });

    test('group sync only removes memberships the directory added; nested groups are optional', async () => {
      await sync();
      const jane = await userByEmail('jane@example.com');
      const [manual] = await db.insert(schema.groups).values({ name: 'manual-grp', description: 'by hand' }).returning();
      await db.insert(schema.userGroups).values({ userId: jane.id, groupId: manual.id });
      ldap.entries = ldap.entries.filter((e) => e.attrs.cn[0] !== 'eng');
      const outer = ldap.addGroup('all-staff', ['cn=ops,ou=groups,dc=example,dc=com']);
      expect(outer).toBeTruthy();
      let r = await sync({ dryRun: false });
      expect(r.body.counts.membershipsRemove).toBe(2); // jane and joe left eng
      expect(await groupsOf('jane@example.com')).toEqual(['manual-grp']);
      expect(await groupsOf('kim@example.com')).toEqual(['ops']);
      await patchDir({ nestedGroups: true });
      await sync();
      expect(await groupsOf('kim@example.com')).toEqual(['all-staff', 'ops']);
      await db.delete(schema.userGroups).where(eq(schema.userGroups.groupId, manual.id));
      await db.delete(schema.groups).where(eq(schema.groups.id, manual.id));
    });

    test('nested group cycles terminate', async () => {
      ldap.addGroup('a', ['cn=b,ou=groups,dc=example,dc=com', 'uid=jane,ou=people,dc=example,dc=com']);
      ldap.addGroup('b', ['cn=a,ou=groups,dc=example,dc=com']);
      await setDirectory({ nestedGroups: true });
      const r = await sync();
      expect(r.body.ok).toBe(true);
      expect(await groupsOf('jane@example.com')).toEqual(['a', 'b', 'eng']);
    });

    test('memberUid style groups match on the login name', async () => {
      ldap.entries = ldap.entries.filter((e) => !e.attrs.objectClass.includes('groupOfNames'));
      ldap.entries.push({ dn: 'cn=posix,ou=groups,dc=example,dc=com', attrs: { objectClass: ['groupOfNames'], cn: ['posix'], memberUid: ['jane', 'kim'] } });
      await setDirectory({ groupMemberAttribute: 'memberUid' });
      await sync();
      expect(await groupsOf('jane@example.com')).toEqual(['posix']);
      expect(await groupsOf('joe@example.com')).toEqual([]);
    });

    test('users without e-mail, duplicate e-mails and e-mails of other accounts are skipped, linking is opt-in', async () => {
      ldap.addUser('noemail', { mail: null });
      ldap.addUser('dupe', { mail: 'jane@example.com', id: 'uuid-dupe' });
      ldap.addUser('plainldap', { mail: 'plain@example.com' });
      const r = await sync();
      const reasons = Object.fromEntries(r.body.skipped.map((s: any) => [s.key, s.reason]));
      expect(reasons['uuid-noemail']).toBe('no_email');
      expect(reasons['uuid-plainldap']).toBe('email_in_use');
      expect(Object.values(reasons)).toContain('duplicate_email');
      await patchDir({ linkByEmail: true });
      const r2 = await sync();
      expect(r2.body.counts.link).toBe(1);
    });

    test('autoProvision off only links and updates, never creates', async () => {
      await setDirectory({ autoProvision: false });
      const r = await sync();
      expect(r.body.counts.create).toBe(0);
      expect(r.body.counts.skipped).toBe(3);
    });

    test('respects the seat limit', async () => {
      const active = (await db.select().from(schema.users)).filter((u) => u.active !== false).length;
      await useTestLicense({ features: ['ldap'], seats: active + 1 });
      const r = await sync();
      expect(r.body.counts.create).toBe(1);
      expect(r.body.skipped.filter((s: any) => s.reason === 'seat_limit').length).toBe(2);
    });

    test('a truncated listing aborts without deactivating anyone', async () => {
      await sync();
      await patchDir({ maxEntries: 2 });
      const r = await sync();
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toContain('more than 2 users');
      expect((await db.select().from(schema.users).where(eq(schema.users.active, false))).length).toBe(0);
    });

    test('an empty directory answer and mass deactivation are refused (force overrides the second)', async () => {
      await sync();
      const saved = ldap.entries;
      ldap.entries = [];
      const empty = await sync();
      expect(empty.body.ok).toBe(false);
      expect(empty.body.error).toContain('no users');
      expect((await userByEmail('jane@example.com')).active).toBe(true);

      ldap.entries = saved;
      for (const n of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) ldap.addUser(n);
      await sync();
      ldap.entries = ldap.entries.filter((e) => ['kim', 'jane'].includes(e.attrs.uid?.[0]) || !e.attrs.uid);
      const guarded = await sync();
      expect(guarded.body.ok).toBe(false);
      expect(guarded.body.error).toContain('force');
      const forced = await sync({ dryRun: false, force: true });
      expect(forced.body.ok).toBe(true);
      expect(forced.body.counts.deactivate).toBeGreaterThan(3);
    });

    test('deactivation can be switched off', async () => {
      await setDirectory({ deactivateMissing: false });
      await sync();
      ldap.remove('jane');
      const r = await sync();
      expect(r.body.counts.deactivate).toBe(0);
      expect((await userByEmail('jane@example.com')).active).toBe(true);
    });

    test('a running sync holds a lease: a second run is refused, the lease is released afterwards and after failures', async () => {
      await db.update(schema.ldapDirectories).set({ syncLockUntil: new Date(Date.now() + 60_000) });
      const blocked = await sync();
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain('already running');
      expect((await sync({ dryRun: true })).body.ok).toBe(true); // a preview needs no lease
      await db.update(schema.ldapDirectories).set({ syncLockUntil: new Date(Date.now() - 1000) });
      expect((await sync()).body.ok).toBe(true);
      expect((await db.select().from(schema.ldapDirectories))[0].syncLockUntil).toBeNull();
      ldap.down = true;
      const failed = await sync();
      expect(failed.body.ok).toBe(false);
      expect((await db.select().from(schema.ldapDirectories))[0].syncLockUntil).toBeNull();
      expect(((await db.select().from(schema.ldapDirectories))[0].lastSyncResult as any).ok).toBe(false);
    });

    test('the scheduler only runs enabled directories whose interval elapsed', async () => {
      expect(await runDueDirectorySyncs()).toBe(0); // sync not enabled
      await db.update(schema.ldapDirectories).set({ syncEnabled: true, syncIntervalMinutes: 60 });
      expect(await runDueDirectorySyncs()).toBe(1);
      expect(await runDueDirectorySyncs()).toBe(0); // interval not elapsed
      await db.update(schema.ldapDirectories).set({ lastSyncAt: new Date(Date.now() - 2 * 3600_000) });
      expect(await runDueDirectorySyncs()).toBe(1);
      await useTestLicense(null);
      await db.update(schema.ldapDirectories).set({ lastSyncAt: new Date(Date.now() - 2 * 3600_000) });
      expect(await runDueDirectorySyncs()).toBe(0); // gated by the licence
    });
  });
});
