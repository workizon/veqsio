import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { checkGlobalPermission, checkProjectPermission } from '../../src/middleware/permissions';
import { explainPermission } from '../../src/admin/helpers';
import { invalidatePermissionCache } from '../../src/rbac/service';

describe('Admin helpers (permission and notification)', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let projectId: number, otherProjectId: number, noSchemeProjectId: number;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const get = (path: string, who = 'admin') => app.request(path, { headers: { Cookie: cookies[who] } });
  const perm = (p: Record<string, string | number>) => get(`/rest/api/2/admin/permission-helper?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))}`);
  const notif = (p: Record<string, string | number>) => get(`/rest/api/2/admin/notification-helper?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))}`);

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    ids.admin = seeded.user.id;
    projectId = seeded.project.id;
    for (const n of ['sysadmin', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'nomail']) {
      const [u] = await db.insert(schema.users).values({ username: n, email: n === 'nomail' ? '' : `${n}@example.com`, displayName: n[0].toUpperCase() + n.slice(1), passwordHash: hash }).returning();
      ids[n] = u.id;
    }
    // A project whose scheme grants things through each kind of entry
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'Team scheme' }).returning();
    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTH', name: 'Other', leadId: ids.bob }).returning();
    const [bare] = await db.insert(schema.projects).values({ projectKey: 'BARE', name: 'No scheme' }).returning();
    otherProjectId = other.id; noSchemeProjectId = bare.id;
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, projectId));
    for (const pid of [projectId, otherProjectId]) await db.insert(schema.permissionSchemeAssociations).values({ projectId: pid, schemeId: scheme.id });
    const [role] = await db.insert(schema.projectRoles).values({ name: 'Developers' }).returning();
    const [group] = await db.insert(schema.groups).values({ name: 'qa-team' }).returning();
    const [adminsGroup] = await db.insert(schema.groups).values({ name: 'sys-admins' }).returning();
    await db.insert(schema.userGroups).values([{ userId: ids.dave, groupId: group.id }, { userId: ids.sysadmin, groupId: adminsGroup.id }]);
    await db.insert(schema.projectRoleActors).values({ projectId, roleId: role.id, userId: ids.carol });
    const [sec] = await db.insert(schema.permissionSchemes).values({ name: 'Admin scheme' }).returning();
    await db.insert(schema.permissionEntries).values([
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', anyUser: true },
      { schemeId: scheme.id, permissionKey: 'EDIT_ISSUES', projectRoleId: role.id },
      { schemeId: scheme.id, permissionKey: 'COMMENT_ISSUE', groupId: group.id },
      { schemeId: scheme.id, permissionKey: 'DELETE_ISSUES', userId: ids.erin },
      { schemeId: scheme.id, permissionKey: 'ASSIGN_ISSUES', anonymous: true },
      { schemeId: sec.id, permissionKey: 'SYSTEM_ADMIN', groupId: adminsGroup.id },
      { schemeId: sec.id, permissionKey: 'CREATE_PROJECT', userId: ids.gina },
    ]);
    await db.insert(schema.issues).values({
      issueKey: 'TEST-1', projectId, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Helper issue',
      reporterId: ids.bob, assigneeId: ids.carol,
    });
    await db.insert(schema.watchers).values({ issueId: (await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-1')))[0].id, userId: ids.dave });
    await invalidatePermissionCache(); // user ids repeat across suites and the real guard caches grants
    for (const n of ['admin', 'sysadmin', 'bob', 'carol']) cookies[n] = await login(n);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  describe('permission helper', () => {
    test('only system administrators may use it', async () => {
      expect((await app.request(`/rest/api/2/admin/permission-helper?userId=${ids.bob}&projectKey=TEST&permission=EDIT_ISSUES`)).status).toBe(401);
      expect((await perm({ userId: ids.bob, projectKey: 'TEST', permission: 'EDIT_ISSUES' })).status).toBe(200); // admin
      for (const who of ['bob', 'carol']) {
        expect((await get(`/rest/api/2/admin/permission-helper?userId=${ids.bob}&projectKey=TEST&permission=EDIT_ISSUES`, who)).status).toBe(403);
        expect((await get(`/rest/api/2/admin/notification-helper?userId=${ids.bob}&issueKey=TEST-1&event=issue.created`, who)).status).toBe(403);
      }
      // a user who holds SYSTEM_ADMIN through a group passes the same guard
      expect((await get(`/rest/api/2/admin/permission-helper?userId=${ids.bob}&projectKey=TEST&permission=EDIT_ISSUES`, 'sysadmin')).status).toBe(200);
    });

    test('allowed through "any logged-in user"', async () => {
      const body = await (await perm({ userId: ids.bob, projectKey: 'TEST', permission: 'BROWSE_PROJECTS' })).json();
      expect(body).toMatchObject({ allowed: true, permission: 'BROWSE_PROJECTS', scope: { type: 'project', projectKey: 'TEST' }, user: { id: ids.bob, username: 'bob' } });
      expect(body.reasons[0]).toMatchObject({ kind: 'any-user', granted: true });
      expect(body.reasons[0].link).toContain('/admin');
    });

    test('allowed through a project role', async () => {
      const body = await (await perm({ userId: ids.carol, projectKey: 'TEST', permission: 'EDIT_ISSUES' })).json();
      expect(body.allowed).toBe(true);
      expect(body.reasons.find((r: any) => r.kind === 'role')).toMatchObject({ granted: true });
      expect(body.reasons.find((r: any) => r.kind === 'role').text).toContain('Developers');
    });

    test('the role grant is per project', async () => {
      const body = await (await perm({ userId: ids.carol, projectKey: 'OTH', permission: 'EDIT_ISSUES' })).json();
      expect(body.allowed).toBe(false);
      expect(body.reasons.find((r: any) => r.kind === 'role')).toMatchObject({ granted: false });
    });

    test('allowed through a group', async () => {
      const body = await (await perm({ userId: ids.dave, projectKey: 'TEST', permission: 'COMMENT_ISSUE' })).json();
      expect(body.allowed).toBe(true);
      expect(body.reasons.find((r: any) => r.kind === 'group')).toMatchObject({ granted: true });
    });

    test('allowed through a single user entry, denied for others, and anonymous-only entries do not count', async () => {
      expect((await (await perm({ userId: ids.erin, projectKey: 'TEST', permission: 'DELETE_ISSUES' })).json()).reasons[0]).toMatchObject({ kind: 'user', granted: true });
      const denied = await (await perm({ userId: ids.bob, projectKey: 'TEST', permission: 'DELETE_ISSUES' })).json();
      expect(denied.allowed).toBe(false);
      expect(denied.reasons.map((r: any) => r.kind)).toEqual(['user', 'missing']);
      const anon = await (await perm({ userId: ids.bob, projectKey: 'TEST', permission: 'ASSIGN_ISSUES' })).json();
      expect(anon.allowed).toBe(false);
      expect(anon.reasons.map((r: any) => r.kind)).toEqual(['missing']);
    });

    test('denied with a missing-grant reason when nothing matches', async () => {
      const body = await (await perm({ userId: ids.bob, projectKey: 'TEST', permission: 'EDIT_ISSUES' })).json();
      expect(body.allowed).toBe(false);
      expect(body.reasons.at(-1)).toMatchObject({ kind: 'missing', granted: false });
      expect(body.reasons.some((r: any) => r.kind === 'role' && r.granted === false)).toBe(true);
    });

    test('issue scope follows the issue guard: browse first, then the permission', async () => {
      const body = await (await perm({ userId: ids.carol, issueKey: 'TEST-1', permission: 'EDIT_ISSUES' })).json();
      expect(body).toMatchObject({ allowed: true, scope: { type: 'issue', issueKey: 'TEST-1', projectKey: 'TEST' } });
      expect(body.reasons[0].text).toContain('Browse access');
      const denied = await (await perm({ userId: ids.bob, issueKey: 'TEST-1', permission: 'EDIT_ISSUES' })).json();
      expect(denied.allowed).toBe(false);
    });

    test('global permissions: group grant, single user grant, missing', async () => {
      expect((await (await perm({ userId: ids.sysadmin, permission: 'SYSTEM_ADMIN' })).json())).toMatchObject({ allowed: true, scope: { type: 'global' } });
      expect((await (await perm({ userId: ids.gina, permission: 'CREATE_PROJECT' })).json()).allowed).toBe(true);
      const denied = await (await perm({ userId: ids.bob, permission: 'CREATE_PROJECT' })).json();
      expect(denied.allowed).toBe(false);
      expect(denied.reasons.at(-1).kind).toBe('missing');
    });

    test('built-in admin is always allowed; a project without scheme falls back to the global check', async () => {
      expect((await (await perm({ userId: ids.admin, projectKey: 'TEST', permission: 'DELETE_ISSUES' })).json()).reasons[0].kind).toBe('builtin-admin');
      const body = await (await perm({ userId: ids.bob, projectKey: 'BARE', permission: 'BROWSE_PROJECTS' })).json();
      expect(body.allowed).toBe(false);
      expect(body.reasons.map((r: any) => r.kind)).toContain('no-scheme');
    });

    test('validation and not-found answers', async () => {
      expect((await get('/rest/api/2/admin/permission-helper?permission=EDIT_ISSUES')).status).toBe(400);
      expect((await perm({ userId: ids.bob, permission: 'EDIT_ISSUES' })).status).toBe(400); // project permission needs a scope
      expect((await perm({ userId: 99999, projectKey: 'TEST', permission: 'EDIT_ISSUES' })).status).toBe(404);
      expect((await perm({ userId: ids.bob, projectKey: 'NOPE', permission: 'EDIT_ISSUES' })).status).toBe(404);
      expect((await perm({ userId: ids.bob, issueKey: 'TEST-99', permission: 'EDIT_ISSUES' })).status).toBe(404);
    });

    test('looking up another user is audited, looking up yourself is not', async () => {
      await perm({ userId: ids.dave, projectKey: 'TEST', permission: 'COMMENT_ISSUE' });
      await perm({ userId: ids.admin, projectKey: 'TEST', permission: 'COMMENT_ISSUE' });
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'PERMISSION_HELPER_LOOKUP'));
      expect(rows.some((r) => r.target === 'dave' && r.actorName === 'admin')).toBe(true);
      expect(rows.some((r) => r.target === 'admin')).toBe(false);
    });

    test('explain() and the real check agree on a table of cases', async () => {
      const perms = ['BROWSE_PROJECTS', 'EDIT_ISSUES', 'COMMENT_ISSUE', 'DELETE_ISSUES', 'ASSIGN_ISSUES', 'CREATE_ISSUES'];
      const users = ['admin', 'sysadmin', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'nomail'];
      const projects: Array<[string, number]> = [['TEST', projectId], ['OTH', otherProjectId], ['BARE', noSchemeProjectId]];
      let compared = 0;
      for (const u of users) {
        const [row] = await db.select().from(schema.users).where(eq(schema.users.id, ids[u]));
        for (const [key, pid] of projects) {
          for (const p of perms) {
            const real = await checkProjectPermission(row, pid, p);
            const explained = await explainPermission({ userId: ids[u], projectKey: key, permission: p });
            expect({ u, key, p, allowed: explained.allowed }).toEqual({ u, key, p, allowed: real });
            // a granted reason exists exactly when the answer is yes, a denial always ends in a not-granted reason
            if (real) expect(explained.reasons.some((r) => r.granted)).toBe(true);
            else expect(explained.reasons.some((r) => r.decisive && r.granted)).toBe(false);
            compared++;
          }
        }
        for (const p of ['SYSTEM_ADMIN', 'ADMINISTER', 'CREATE_PROJECT', 'BROWSE_USERS']) {
          const real = await checkGlobalPermission(row, p);
          const explained = await explainPermission({ userId: ids[u], permission: p });
          expect({ u, p, allowed: explained.allowed }).toEqual({ u, p, allowed: real });
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(150);
    });
  });

  describe('notification helper', () => {
    const kinds = (b: any) => Object.fromEntries(b.reasons.filter((r: any) => r.decisive).map((r: any) => [r.kind, r.granted]));

    test('assignee is notified when an issue is updated', async () => {
      const body = await (await notif({ issueKey: 'TEST-1', event: 'issue.updated', userId: ids.carol })).json();
      expect(body).toMatchObject({ notified: true, event: { id: 'issue.updated' }, user: { username: 'carol' } });
      expect(kinds(body)).toMatchObject({ assignee: true, reporter: false, watcher: false });
      expect(body.reasons.find((r: any) => r.kind === 'assignee').text).toContain('assignee');
    });

    test('reporter, watcher and project lead rules', async () => {
      expect(kinds(await (await notif({ issueKey: 'TEST-1', event: 'comment.added', userId: ids.bob })).json())).toMatchObject({ reporter: true, assignee: false });
      expect(kinds(await (await notif({ issueKey: 'TEST-1', event: 'comment.added', userId: ids.dave })).json())).toMatchObject({ watcher: true });
      const lead = await (await notif({ issueKey: 'TEST-1', event: 'issue.created', userId: ids.admin })).json();
      expect(lead.notified).toBe(true);
      expect(kinds(lead)['project-lead']).toBe(true);
    });

    test('a user without any matching rule is not notified', async () => {
      const body = await (await notif({ issueKey: 'TEST-1', event: 'issue.updated', userId: ids.frank })).json();
      expect(body.notified).toBe(false);
      expect(body.deliverable).toBe(false);
    });

    test('the person who caused the event is not notified, unless it is an assignment', async () => {
      const own = await (await notif({ issueKey: 'TEST-1', event: 'comment.added', userId: ids.carol, actorId: ids.carol })).json();
      expect(own.notified).toBe(false);
      expect(own.reasons.find((r: any) => r.kind === 'actor')).toMatchObject({ granted: false });
      const assigned = await (await notif({ issueKey: 'TEST-1', event: 'issue.assigned', userId: ids.carol, actorId: ids.carol })).json();
      expect(assigned.notified).toBe(true);
      expect((await (await notif({ issueKey: 'TEST-1', event: 'issue.assigned', userId: ids.bob })).json()).notified).toBe(false);
    });

    test('a recipient without an e-mail address is not notified', async () => {
      const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-1'));
      await db.insert(schema.watchers).values({ issueId: issue.id, userId: ids.nomail });
      const body = await (await notif({ issueKey: 'TEST-1', event: 'issue.updated', userId: ids.nomail })).json();
      expect(body.notified).toBe(false);
      expect(body.reasons.find((r: any) => r.kind === 'email')).toMatchObject({ granted: false });
    });

    test('mail server and preference facts are listed', async () => {
      const body = await (await notif({ issueKey: 'TEST-1', event: 'issue.updated', userId: ids.carol })).json();
      expect(body.reasons.some((r: any) => r.kind === 'mail-server')).toBe(true);
      expect(body.reasons.some((r: any) => r.kind === 'preferences')).toBe(true);
    });

    test('validation, events list and audit', async () => {
      expect((await notif({ issueKey: 'TEST-1', event: 'bogus', userId: ids.bob })).status).toBe(400);
      expect((await notif({ issueKey: 'TEST-1', event: 'issue.created' })).status).toBe(400);
      expect((await notif({ issueKey: 'NOPE-1', event: 'issue.created', userId: ids.bob })).status).toBe(404);
      const events = await (await get('/rest/api/2/admin/notification-helper/events')).json();
      expect(events.events.map((e: any) => e.id)).toContain('comment.added');
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'NOTIFICATION_HELPER_LOOKUP'));
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
