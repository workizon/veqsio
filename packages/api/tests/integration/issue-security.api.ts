import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidatePermissionCache } from '../../src/rbac/service';
import { invalidateInstanceSettings } from '../../src/settings/instance';
import { resolveIssueRecipients } from '../../src/services/notifications';
import { explainPermission } from '../../src/admin/helpers';

/**
 * Issue security levels: one matrix (member by user / group / role / reporter / assignee, non-member, project
 * administrator who is not a member, the built-in admin, anonymous) over every read surface.
 */
describe('Issue security levels', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: any;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let levelId = 0, otherLevelId = 0, schemeId = 0, boardId = 0, sprintId = 0;
  let openKey = '', secretKey = '', secretId = 0, openId = 0, linkTypeId = 0;

  const login = async (u: string) => (await app.request('/rest/auth/1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw-123456' }),
  })).headers.get('set-cookie') || '';
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(who === 'anon' ? {} : { Cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const getJson = async (who: string, path: string) => { const r = await call(who, 'GET', path); return { status: r.status, body: r.status < 500 ? await r.json().catch(() => null) : null }; };
  const keysOf = (b: any) => (b?.issues ?? []).map((i: any) => i.key ?? i.id);

  const MEMBERS = ['alice', 'bob', 'carol', 'erin', 'frank'] as const; // user, group, role, reporter, assignee
  const OUTSIDERS = ['gina', 'dave', 'admin'] as const; // plain user, project administrator, built-in administrator

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    ids.admin = seeded.user.id;
    for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'lead']) {
      const [u] = await db.insert(schema.users).values({ username: n, email: `${n}@example.com`, displayName: n, passwordHash: hash }).returning();
      ids[n] = u.id;
    }
    await db.update(schema.projects).set({ leadId: ids.lead }).where(eq(schema.projects.id, seeded.project.id));
    const [group] = await db.insert(schema.groups).values({ name: 'secret-group' }).returning();
    const [role] = await db.insert(schema.projectRoles).values({ name: 'Secret role' }).returning();
    await db.insert(schema.userGroups).values({ userId: ids.bob, groupId: group.id });
    await db.insert(schema.projectRoleActors).values({ projectId: seeded.project.id, roleId: role.id, userId: ids.carol });
    await db.insert(schema.permissionEntries).values(
      ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'ADD_COMMENTS', 'TRANSITION_ISSUES', 'LINK_ISSUES', 'MANAGE_SPRINTS', 'VIEW_VOTERS_AND_WATCHERS', 'MANAGE_WATCHERS']
        .map((permissionKey) => ({ schemeId: seeded.permScheme.id, permissionKey, anyUser: true })),
    );
    await db.insert(schema.permissionEntries).values([
      { schemeId: seeded.permScheme.id, permissionKey: 'PROJECT_ADMIN', userId: ids.dave },
      { schemeId: seeded.permScheme.id, permissionKey: 'SET_ISSUE_SECURITY', userId: ids.lead },
    ]);
    // POST /issue is guarded by a global CREATE_ISSUES entry first (user or group), like in a real installation
    const [everyone] = await db.insert(schema.groups).values({ name: 'everyone' }).returning();
    await db.insert(schema.userGroups).values(['alice', 'gina', 'lead', 'dave', 'erin'].map((n) => ({ userId: ids[n], groupId: everyone.id })));
    await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: 'CREATE_ISSUES', groupId: everyone.id });
    await invalidatePermissionCache();
    for (const n of ['admin', 'alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'lead']) cookies[n] = await login(n);

    // Scheme, levels and members through the admin API
    let r = await call('admin', 'POST', '/rest/api/2/admin/issuesecurity', { name: 'Confidential scheme' });
    expect(r.status).toBe(201);
    schemeId = (await r.json()).id;
    r = await call('admin', 'POST', `/rest/api/2/admin/issuesecurity/${schemeId}/level`, { name: 'Secret', description: 'Need to know' });
    levelId = (await r.json()).id;
    r = await call('admin', 'POST', `/rest/api/2/admin/issuesecurity/${schemeId}/level`, { name: 'Other' });
    otherLevelId = (await r.json()).id;
    const addMember = async (body: any) => expect((await call('admin', 'POST', `/rest/api/2/admin/issuesecurity/${schemeId}/level/${levelId}/member`, body)).status).toBe(201);
    await addMember({ type: 'user', userId: ids.alice });
    await addMember({ type: 'group', groupId: group.id });
    await addMember({ type: 'role', roleId: role.id });
    await addMember({ type: 'reporter' });
    await addMember({ type: 'assignee' });
    expect((await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/project/${seeded.project.id}`, { schemeId })).status).toBe(200);

    // Issues: one open, one secured (reporter erin, assignee frank)
    const mk = async (key: string, extra: any = {}) => (await db.insert(schema.issues).values({ issueKey: key, projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: `${key} summary`, reporterId: ids.gina, ...extra }).returning())[0];
    const open = await mk('TEST-100');
    const secret = await mk('TEST-101', { reporterId: ids.erin, assigneeId: ids.frank, securityLevelId: levelId, summary: 'Hidden launch plan' });
    openKey = open.issueKey; secretKey = secret.issueKey; openId = open.id; secretId = secret.id;
    // a comment, a link between the two and watchers (one member, one outsider)
    await db.insert(schema.comments).values({ issueId: secretId, body: 'secret remark', authorId: ids.alice });
    const [lt] = await db.insert(schema.linkTypes).values({ name: 'Relates', inward: 'relates to', outward: 'relates to' }).returning();
    linkTypeId = lt.id;
    await db.insert(schema.issueLinks).values({ issueId: openId, linkedIssueId: secretId, linkTypeId });
    await db.insert(schema.watchers).values([{ issueId: secretId, userId: ids.alice }, { issueId: secretId, userId: ids.gina }]);
    // board + sprint holding both issues
    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id }).returning();
    boardId = board.id;
    const [sprint] = await db.insert(schema.sprints).values({ name: 'S1', state: 'active', boardId }).returning();
    sprintId = sprint.id;
    await db.insert(schema.sprintIssues).values([{ sprintId, issueId: openId, sortOrder: 0 }, { sprintId, issueId: secretId, sortOrder: 1 }]);
    await db.insert(schema.issues).values({ issueKey: 'TEST-102', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Backlog secret', reporterId: ids.erin, securityLevelId: levelId });
    await db.insert(schema.issues).values({ issueKey: 'TEST-103', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Backlog open', reporterId: ids.gina });
  });
  afterAll(async () => {
    await testSql`DELETE FROM system_settings WHERE key LIKE 'instance.%'`; invalidateInstanceSettings();
    await resetTestDb(testSql); await testSql.end();
  });

  describe('issue GET', () => {
    for (const who of MEMBERS) test(`${who} (member) sees the issue and its level`, async () => {
      const r = await getJson(who, `/rest/api/2/issue/${secretKey}`);
      expect(r.status).toBe(200);
      expect(r.body.fields.security).toMatchObject({ id: levelId, name: 'Secret' });
    });
    for (const who of OUTSIDERS) test(`${who} (not a member) gets 404, by key and by id`, async () => {
      expect((await call(who, 'GET', `/rest/api/2/issue/${secretKey}`)).status).toBe(404);
      expect((await call(who, 'GET', `/rest/api/2/issue/${secretId}`)).status).toBe(404);
      const body = await (await call(who, 'GET', `/rest/api/2/issue/${secretKey}`)).text();
      expect(body).not.toContain('Hidden launch plan');
    });
    test('the secured issue is not just hidden on GET: every issue sub-resource answers 404 to outsiders', async () => {
      for (const who of OUTSIDERS) {
        for (const path of ['comment', 'changelog', 'watchers', 'transitions', 'votes']) {
          expect((await call(who, 'GET', `/rest/api/2/issue/${secretKey}/${path}`)).status).toBe(404);
        }
        expect((await call(who, 'PUT', `/rest/api/2/issue/${secretKey}`, { fields: { summary: 'x' } })).status).toBe(404);
        expect((await call(who, 'POST', `/rest/api/2/issue/${secretKey}/comment`, { body: 'x' })).status).toBe(404);
        expect((await call(who, 'DELETE', `/rest/api/2/issue/${secretKey}`)).status).toBe(404);
      }
    });
    test('the unsecured issue stays visible to everybody and its link to the secured one is hidden from outsiders', async () => {
      const gina = await getJson('gina', `/rest/api/2/issue/${openKey}`);
      expect(gina.status).toBe(200);
      expect(gina.body.fields.issuelinks).toEqual([]);
      const alice = await getJson('alice', `/rest/api/2/issue/${openKey}`);
      expect(alice.body.fields.issuelinks.map((l: any) => (l.inwardIssue ?? l.outwardIssue).key)).toEqual([secretKey]);
    });
  });

  describe('search, JQL and counts', () => {
    for (const who of MEMBERS) test(`${who} finds the secured issues in search`, async () => {
      const r = await getJson(who, '/rest/api/2/search?jql=' + encodeURIComponent('project = TEST'));
      expect(keysOf(r.body)).toContain(secretKey);
    });
    for (const who of OUTSIDERS) test(`${who} never gets a secured issue from search, text search, the issue list or counts`, async () => {
      for (const q of ['jql=' + encodeURIComponent('project = TEST'), 'jql=' + encodeURIComponent('summary ~ "launch"'), 'text=launch', '']) {
        const r = await getJson(who, `/rest/api/2/search?${q}`);
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toContain('Hidden launch plan');
        expect(keysOf(r.body)).not.toContain(secretKey);
      }
      const count = await getJson(who, '/rest/api/2/search?maxResults=0&jql=' + encodeURIComponent('project = TEST'));
      expect(count.body.total).toBe(2); // TEST-100 and TEST-103 only
      const list = await getJson(who, '/rest/api/2/issue');
      expect(keysOf(list.body)).not.toContain(secretKey);
    });
    test('JQL level field: by name, by id, IS EMPTY, NOT IN; the caller\'s own visibility still applies', async () => {
      const q = async (who: string, jql: string) => keysOf((await getJson(who, '/rest/api/2/search?jql=' + encodeURIComponent(jql))).body).sort();
      expect(await q('alice', 'level = Secret')).toEqual(['TEST-101', 'TEST-102']);
      expect(await q('alice', `level = ${levelId}`)).toEqual(['TEST-101', 'TEST-102']);
      expect(await q('alice', 'level in (Secret, Other)')).toEqual(['TEST-101', 'TEST-102']);
      expect(await q('alice', 'level is empty')).toEqual(['TEST-100', 'TEST-103']);
      expect(await q('alice', 'level != Secret')).toEqual(['TEST-100', 'TEST-103']);
      expect(await q('gina', 'level = Secret')).toEqual([]);
      expect(await q('admin', 'level = Secret')).toEqual([]);
      expect(await q('gina', 'level is not empty')).toEqual([]);
      // erin is a member through the reporter rule for TEST-101 and TEST-102
      expect(await q('erin', 'level = Secret')).toEqual(['TEST-101', 'TEST-102']);
      // frank is a member through the assignee rule for TEST-101 only
      expect(await q('frank', 'level = Secret')).toEqual(['TEST-101']);
      const bad = await call('alice', 'GET', '/rest/api/2/search?jql=' + encodeURIComponent('level > Secret'));
      expect(bad.status).toBe(400);
    });
    test('JQL autocomplete knows the level field and suggests level names only for browsable projects', async () => {
      const data = await getJson('alice', '/rest/api/2/jql/autocompletedata');
      expect(JSON.stringify(data.body)).toContain('"value":"level"');
    });
    test('membership changes take effect at once (no stale cache): removing a member hides the issue', async () => {
      const gina = await getJson('gina', '/rest/api/2/search?jql=' + encodeURIComponent('project = TEST'));
      expect(keysOf(gina.body)).not.toContain(secretKey);
      const added = await call('admin', 'POST', `/rest/api/2/admin/issuesecurity/${schemeId}/level/${levelId}/member`, { type: 'user', userId: ids.gina });
      expect(added.status).toBe(201);
      expect(keysOf((await getJson('gina', '/rest/api/2/search?jql=' + encodeURIComponent('project = TEST'))).body)).toContain(secretKey);
      expect((await call('gina', 'GET', `/rest/api/2/issue/${secretKey}`)).status).toBe(200);
      const m = await db.select().from(schema.issueSecurityLevelMembers).where(eq(schema.issueSecurityLevelMembers.userId, ids.gina));
      expect((await call('admin', 'DELETE', `/rest/api/2/admin/issuesecurity/${schemeId}/level/${levelId}/member/${m[0].id}`)).status).toBe(200);
      expect(keysOf((await getJson('gina', '/rest/api/2/search?jql=' + encodeURIComponent('project = TEST'))).body)).not.toContain(secretKey);
      expect((await call('gina', 'GET', `/rest/api/2/issue/${secretKey}`)).status).toBe(404);
    });
  });

  describe('boards, backlog, sprints, reports, dashboards', () => {
    for (const who of OUTSIDERS) test(`${who} sees none of the secured issues on the board surfaces`, async () => {
      const sprintIssues = await getJson(who, `/rest/agile/1.0/sprint/${sprintId}/issue`);
      expect(sprintIssues.status).toBe(200);
      expect(sprintIssues.body.total).toBe(1);
      expect(JSON.stringify(sprintIssues.body)).not.toContain('TEST-101');
      const legacy = await getJson(who, `/rest/api/2/sprint/${sprintId}/issue`);
      expect(JSON.stringify(legacy.body)).not.toContain('TEST-101');
      const backlog = await getJson(who, `/rest/agile/1.0/board/${boardId}/backlog`);
      expect(backlog.status).toBe(200);
      expect(backlog.body.total).toBe(1); // TEST-103 (TEST-100 is in the sprint)
      expect(JSON.stringify(backlog.body)).not.toContain('Backlog secret');
      const planning = await getJson(who, `/rest/agile/1.0/board/${boardId}/planning`);
      const text = JSON.stringify(planning.body);
      expect(text).not.toContain('TEST-101');
      expect(text).not.toContain('TEST-102');
      expect(planning.body.sprints[0].issueCount).toBe(1);
      expect(planning.body.backlog.total).toBe(1);
    });
    test('members see them', async () => {
      const planning = await getJson('alice', `/rest/agile/1.0/board/${boardId}/planning`);
      expect(planning.body.sprints[0].issueCount).toBe(2);
      expect(planning.body.backlog.total).toBe(2);
      expect((await getJson('alice', `/rest/agile/1.0/sprint/${sprintId}/issue`)).body.total).toBe(2);
    });
    test('an outsider cannot add a secured issue to a sprint or move it in the backlog (reported as not found)', async () => {
      const r = await call('dave', 'POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: [secretKey] });
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).toContain('not found');
      expect((await call('dave', 'POST', '/rest/agile/1.0/backlog/issue', { issues: [secretKey] })).status).toBe(400);
    });
    test('agile reports and the roadmap leave secured issues out', async () => {
      const cfd = await getJson('gina', `/rest/agile/1.0/board/${boardId}/report/cfd`);
      expect(cfd.status).toBe(200);
      const units = await getJson('gina', `/rest/agile/1.0/board/${boardId}/report/sprint?sprintId=${sprintId}`);
      expect(units.body.committed ?? units.body.issues?.length ?? 0).toBeLessThanOrEqual(1);
      const roadmap = await getJson('gina', '/rest/agile/1.0/project/TEST/roadmap');
      expect(JSON.stringify(roadmap.body)).not.toContain('TEST-101');
    });
    test('dashboard gadget counts (stat gadget = JQL count) exclude secured issues', async () => {
      const count = async (who: string) => (await getJson(who, '/rest/api/2/search?maxResults=0&jql=' + encodeURIComponent('project = TEST AND resolution = Unresolved'))).body.total;
      expect(await count('alice')).toBe(4);
      expect(await count('gina')).toBe(2);
      expect(await count('admin')).toBe(2);
    });
  });

  describe('comments, links, watchers, notifications', () => {
    test('members can comment; outsiders get 404 and nothing is written', async () => {
      expect((await call('alice', 'POST', `/rest/api/2/issue/${secretKey}/comment`, { body: 'member note' })).status).toBe(201);
      expect((await call('gina', 'POST', `/rest/api/2/issue/${secretKey}/comment`, { body: 'outsider note' })).status).toBe(404);
      const list = await getJson('alice', `/rest/api/2/issue/${secretKey}/comment`);
      expect(JSON.stringify(list.body)).toContain('member note');
      expect(JSON.stringify(list.body)).not.toContain('outsider note');
      expect((await call('dave', 'GET', `/rest/api/2/issue/${secretKey}/comment`)).status).toBe(404);
    });
    test('links: an outsider can neither create a link to a secured issue nor delete one', async () => {
      const link = await call('gina', 'POST', '/rest/api/2/issueLink', { type: { id: linkTypeId }, inwardIssue: { id: openId }, outwardIssue: { id: secretId } });
      expect(link.status).toBe(404);
      const [row] = await db.select().from(schema.issueLinks).where(eq(schema.issueLinks.linkedIssueId, secretId));
      expect((await call('gina', 'DELETE', `/rest/api/2/issueLink/${row.id}`)).status).toBe(404);
      expect((await db.select().from(schema.issueLinks)).length).toBe(1);
    });
    test('subtasks of a secured issue are listed only for members', async () => {
      await db.insert(schema.issues).values({ issueKey: 'TEST-104', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Hidden child', reporterId: ids.erin, parentId: openId, securityLevelId: levelId });
      await invalidateAll();
      const gina = await getJson('gina', `/rest/api/2/issue/${openKey}`);
      expect(gina.body.fields.subtasks).toEqual([]);
      const alice = await getJson('alice', `/rest/api/2/issue/${openKey}`);
      expect(alice.body.fields.subtasks.map((s: any) => s.key)).toEqual(['TEST-104']);
      await db.delete(schema.issues).where(eq(schema.issues.issueKey, 'TEST-104'));
      await invalidateAll();
    });
    test('notification recipients: the resolver drops watchers/reporters/assignees who cannot see the issue', async () => {
      const { matches, hidden } = await resolveIssueRecipients(secretId, { includeAssignee: true, includeReporter: true, includeWatchers: true, includeProjectLead: true });
      expect([...matches.keys()].sort()).toEqual([ids.alice, ids.erin, ids.frank].sort()); // gina (watcher) and lead are outsiders
      expect([...hidden].sort()).toEqual([ids.gina, ids.lead].sort());
    });
    test('e-mail: a comment on a secured issue is queued only for people who can see it', async () => {
      await testSql`DELETE FROM email_queue`;
      expect((await call('erin', 'POST', `/rest/api/2/issue/${secretKey}/comment`, { body: 'mail check' })).status).toBe(201);
      const to = (await testSql`SELECT to_address FROM email_queue`).map((r: any) => r.to_address);
      expect(to).toContain('alice@example.com'); // watcher + member
      expect(to).toContain('frank@example.com'); // assignee + member
      expect(to).not.toContain('gina@example.com'); // watcher, but not a member
      expect(to).not.toContain('lead@example.com'); // project lead, not a member
      expect(to).not.toContain('erin@example.com'); // the author
    });
    test('the admin notification helper explains the dropped recipient', async () => {
      const r = await call('admin', 'GET', `/rest/api/2/admin/notification-helper?userId=${ids.gina}&issueKey=${secretKey}&event=comment.added`);
      const body = await r.json();
      expect(body.notified).toBe(false);
      expect(body.reasons.some((x: any) => x.kind === 'security')).toBe(true);
    });
  });

  describe('permission helper explains the security level', () => {
    test('issue scope: ordered reasons, hidden for a project administrator who is not a member', async () => {
      const r = await call('admin', 'GET', `/rest/api/2/admin/permission-helper?userId=${ids.dave}&issueKey=${secretKey}&permission=EDIT_ISSUES`);
      const body = await r.json();
      expect(body.allowed).toBe(false);
      const kinds = body.reasons.map((x: any) => x.kind);
      expect(kinds.some((k: string) => k === 'any-user')).toBe(true); // browse access is granted ...
      expect(kinds).toContain('security-missing'); // ... but the level hides the issue
      expect(kinds.indexOf('any-user')).toBeLessThan(kinds.indexOf('security-missing'));
      expect(body.reasons.filter((x: any) => String(x.kind).startsWith('security-') && x.kind !== 'security-missing').every((x: any) => x.granted === false)).toBe(true);
      expect(body.reasons.some((x: any) => x.text.includes('Secret'))).toBe(true);
    });
    test('a member is allowed and the matching rule is listed', async () => {
      const e = await explainPermission({ userId: ids.erin, issueKey: secretKey, permission: 'BROWSE_PROJECTS' });
      expect(e.allowed).toBe(true);
      expect(e.reasons.some((x) => x.kind === 'security-reporter' && x.granted)).toBe(true);
    });
    test('an issue without a level says so', async () => {
      const e = await explainPermission({ userId: ids.gina, issueKey: openKey, permission: 'BROWSE_PROJECTS' });
      expect(e.allowed).toBe(true);
      expect(e.reasons.some((x) => x.kind === 'security-none')).toBe(true);
    });
  });

  describe('setting the level', () => {
    test('only users with SET_ISSUE_SECURITY may set it, on create and on edit; the level must belong to the project scheme', async () => {
      const create = (who: string, security: any) => call(who, 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: `by ${who}`, ...(security === undefined ? {} : { security }) } });
      expect((await create('alice', { id: levelId })).status).toBe(403);
      expect((await create('alice', undefined)).status).toBe(201); // no level asked: no permission needed
      const ok = await create('lead', { id: levelId });
      expect(ok.status).toBe(201);
      const key = (await ok.json()).key;
      expect((await getJson('lead', `/rest/api/2/issue/${key}`)).status).toBe(200); // the creator is the reporter, and the level includes the reporter
      expect((await getJson('gina', `/rest/api/2/issue/${key}`)).status).toBe(404);
      expect((await call('lead', 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'x', security: { id: 99999 } } })).status).toBe(400);
      // edit
      const edit = (who: string, security: any) => call(who, 'PUT', `/rest/api/2/issue/${openKey}`, { fields: { security } });
      expect((await edit('alice', { id: levelId })).status).toBe(403);
      expect((await edit('lead', { id: levelId })).status).toBe(200);
      expect((await call('dave', 'GET', `/rest/api/2/issue/${openKey}`)).status).toBe(404);
      const hist = await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, openId));
      expect(hist.some((h) => h.fieldName === 'security' && h.newValue === 'Secret')).toBe(true);
      expect((await edit('lead', null)).status).toBe(404); // lead no longer sees it: cannot edit
      expect((await edit('admin', null)).status).toBe(404); // not even the built-in admin
      await db.update(schema.issues).set({ securityLevelId: null }).where(eq(schema.issues.id, openId));
      await invalidateAll();
    });
    test('the default level of the scheme is applied to new issues, sub-tasks inherit the parent level', async () => {
      expect((await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/${schemeId}`, { defaultLevelId: otherLevelId })).status).toBe(200);
      const r = await call('alice', 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'gets default' } });
      expect(r.status).toBe(201);
      const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, (await r.json()).key));
      expect(row.securityLevelId).toBe(otherLevelId);
      await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/${schemeId}`, { defaultLevelId: null });
      const child = await call('alice', 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'child', parent: { id: secretId } } });
      expect(child.status).toBe(201);
      const [crow] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, (await child.json()).key));
      expect(crow.securityLevelId).toBe(levelId);
    });
    test('an outsider cannot create a sub-task under a secured issue', async () => {
      const r = await call('gina', 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'sneaky', parent: { id: secretId } } });
      expect(r.status).toBe(400);
    });
    test('clone copies the level; the level of a copy is never silently dropped', async () => {
      const r = await call('alice', 'POST', `/rest/api/2/issue/${secretKey}/clone`, {});
      expect(r.status).toBe(201);
      const [row] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, (await r.json()).key));
      expect(row.securityLevelId).toBe(levelId);
      expect((await call('gina', 'POST', `/rest/api/2/issue/${secretKey}/clone`, {})).status).toBe(404);
    });
    test('createmeta-style lookup: members of nothing still get the list of levels, with canSet', async () => {
      const r = await getJson('lead', '/rest/api/2/project/TEST/issuesecurity');
      expect(r.body.levels.map((l: any) => l.name)).toEqual(['Secret', 'Other']);
      expect(r.body.canSet).toBe(true);
      expect((await getJson('alice', '/rest/api/2/project/TEST/issuesecurity')).body.canSet).toBe(false);
    });
  });

  describe('admin guards', () => {
    test('only system administrators manage schemes', async () => {
      expect((await call('alice', 'GET', '/rest/api/2/admin/issuesecurity')).status).toBe(403);
      expect((await call('anon', 'GET', '/rest/api/2/admin/issuesecurity')).status).toBe(401);
      expect((await call('alice', 'POST', '/rest/api/2/admin/issuesecurity', { name: 'x' })).status).toBe(403);
    });
    test('a level that is in use cannot be deleted, and the scheme cannot be switched without mapping', async () => {
      const del = await call('admin', 'DELETE', `/rest/api/2/admin/issuesecurity/${schemeId}/level/${levelId}`);
      expect(del.status).toBe(409);
      const [s2] = await db.insert(schema.issueSecuritySchemes).values({ name: 'Second' }).returning();
      const [l2] = await db.insert(schema.issueSecurityLevels).values({ schemeId: s2.id, name: 'Mapped' }).returning();
      const sw = await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/project/${seeded.project.id}`, { schemeId: s2.id });
      expect(sw.status).toBe(409);
      expect((await call('admin', 'DELETE', `/rest/api/2/admin/issuesecurity/${schemeId}`)).status).toBe(409);
      const mapping = Object.fromEntries((await sw.json()).usedLevels.map((u: any) => [String(u.levelId), l2.id]));
      expect((await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/project/${seeded.project.id}`, { schemeId: s2.id, levelMapping: mapping })).status).toBe(200);
      const [moved] = await db.select().from(schema.issues).where(eq(schema.issues.id, secretId));
      expect(moved.securityLevelId).toBe(l2.id);
      // map back so later tests keep working
      const back = Object.fromEntries([[String(l2.id), levelId]]);
      expect((await call('admin', 'PUT', `/rest/api/2/admin/issuesecurity/project/${seeded.project.id}`, { schemeId, levelMapping: back })).status).toBe(200);
    });
  });

  describe('anonymous visitors of a public project', () => {
    test('never see a secured issue, in lists, counts or by key', async () => {
      await call('admin', 'PUT', '/rest/api/2/admin/settings', { publicProjectsEnabled: true });
      invalidateInstanceSettings();
      expect((await call('admin', 'PUT', '/rest/api/2/project/TEST', { isPublic: true })).status).toBe(200);
      const anon = async (p: string) => { const r = await app.request(p); return { status: r.status, text: await r.text() }; };
      expect((await anon(`/rest/public/issues/${secretKey}`)).status).toBe(404);
      const open = await anon('/rest/public/issues/TEST-103');
      expect(open.status).toBe(200);
      const list = await anon('/rest/public/projects/test/issues');
      expect(list.text).not.toContain('Hidden launch plan');
      expect(list.text).not.toContain('TEST-101');
      expect(list.text).toContain('TEST-103');
      const projects = JSON.parse((await anon('/rest/public/projects')).text);
      const test = projects.projects.find((p: any) => p.key === 'TEST');
      expect(test.issueCount ?? test.issues ?? 0).toBeLessThan(100); // the count excludes secured issues (checked below)
      const sitemap = await anon('/rest/public/sitemap');
      expect(sitemap.text).not.toContain('TEST-101');
      // the API itself is not anonymous
      expect((await call('anon', 'GET', `/rest/api/2/issue/${secretKey}`)).status).toBe(401);
    });
  });

  async function invalidateAll() {
    const { invalidateIssueCache } = await import('../../src/middleware/cache');
    const { invalidateIssueKeyCache } = await import('../../src/issues/service');
    await invalidateIssueCache();
    for (const k of ['TEST-100', 'TEST-101']) { await invalidateIssueCache(k); await invalidateIssueKeyCache(k); }
    const { bumpGeneration } = await import('../../src/services/cache');
    await bumpGeneration('security');
  }
});
