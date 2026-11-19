import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { invalidateFeatures, invalidateProjectFeatures } from '../../src/features';

describe('Initiatives, milestones and releases', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  let admin: string;
  let owner: string;
  let member: string;
  let outsider: string;
  let pa: string;
  let ownerId: number;
  let secretProjectId: number;
  let moveTargetId: number;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (p: Promise<Response>) => (await p).json() as Promise<any>;

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [o, m, x, p] = await db.insert(schema.users).values([
      { username: 'owner', email: 'o@x.test', displayName: 'Owner', passwordHash: hash },
      { username: 'member', email: 'm@x.test', displayName: 'Member', passwordHash: hash },
      { username: 'outsider', email: 'x@x.test', displayName: 'Outsider', passwordHash: hash },
      { username: 'projadmin', email: 'p@x.test', displayName: 'Project admin', passwordHash: hash },
    ]).returning();
    ownerId = o.id;

    // TEST: browse for owner/member/projadmin, edit for owner/projadmin, project admin for projadmin.
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'IM' }).returning();
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, seeded.project.id));
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: seeded.project.id, schemeId: scheme.id });
    await db.insert(schema.permissionEntries).values([
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: o.id },
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: m.id },
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: p.id },
      { schemeId: scheme.id, permissionKey: 'EDIT_ISSUES', userId: o.id },
      { schemeId: scheme.id, permissionKey: 'EDIT_ISSUES', userId: p.id },
      { schemeId: scheme.id, permissionKey: 'PROJECT_ADMIN', userId: p.id },
    ]);
    // SECR: nobody but administrators can browse.
    const [secret] = await db.insert(schema.projects).values({ projectKey: 'SECR', name: 'Secret', leadId: seeded.user.id }).returning();
    secretProjectId = secret.id;
    const [mv] = await db.insert(schema.projects).values({ projectKey: 'MV', name: 'Move target', leadId: seeded.user.id }).returning();
    moveTargetId = mv.id;
    const [closed] = await db.insert(schema.permissionSchemes).values({ name: 'Closed' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: secret.id, schemeId: closed.id });

    await redis.del(...[seeded.user.id, o.id, m.id, x.id, p.id].map((id: number) => `veqsio:ratelimit:user:${id}`), 'veqsio:ratelimit:ip:unknown');
    admin = await login('admin'); owner = await login('owner'); member = await login('member'); outsider = await login('outsider'); pa = await login('projadmin');

    const [epic] = await db.insert(schema.issueTypes).values({ name: 'Epic', isSubtask: false }).returning();
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#0a0' }).returning();
    const [cancelled] = await db.insert(schema.statuses).values({ name: 'Cancelled', category: 'cancelled', color: '#a00' }).returning();
    const base = { reporterId: seeded.user.id };
    const [e1] = await db.insert(schema.issues).values({ issueKey: 'TEST-1', projectId: seeded.project.id, issueTypeId: epic.id, statusId: seeded.status.id, summary: 'Epic one', ...base }).returning();
    await db.insert(schema.issues).values([
      { issueKey: 'TEST-2', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: done.id, summary: 'Done child', parentId: e1.id, ...base },
      { issueKey: 'TEST-3', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Todo child', parentId: e1.id, ...base },
      { issueKey: 'TEST-4', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: cancelled.id, summary: 'Cancelled child', parentId: e1.id, ...base },
      { issueKey: 'TEST-5', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'Loose task', ...base },
    ]);
    const [e2] = await db.insert(schema.issues).values({ issueKey: 'SECR-1', projectId: secret.id, issueTypeId: epic.id, statusId: seeded.status.id, summary: 'Secret epic', ...base }).returning();
    await db.insert(schema.issues).values({ issueKey: 'SECR-2', projectId: secret.id, issueTypeId: seeded.issueType.id, statusId: done.id, summary: 'Secret done', parentId: e2.id, ...base });
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  /* ------------------------------------------------------------------ */
  describe('initiatives', () => {
    let id = 0;
    let secretOnly = 0;
    const base = '/rest/api/2/initiatives';

    test('requires authentication', async () => {
      expect((await app.request(base)).status).toBe(401);
      expect((await app.request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
      expect((await app.request(`${base}/1`)).status).toBe(401);
    });

    test('anyone signed in can create; the creator is the owner; only admins can name another owner', async () => {
      const res = await req('POST', base, owner, { name: 'Launch 2026', description: 'Big', startDate: '2026-01-01', targetDate: '2026-12-31', status: 'active' });
      expect(res.status).toBe(201);
      const created = await res.json() as any;
      id = created.id;
      expect(created).toMatchObject({ name: 'Launch 2026', status: 'active', statusLabel: 'Active', owner: { displayName: 'Owner' }, canManage: true });
      expect((await req('POST', base, owner, { name: 'X', ownerId: seeded.user.id })).status).toBe(403);
      const byAdmin = await req('POST', base, admin, { name: 'By admin', ownerId: ownerId });
      expect(byAdmin.status).toBe(201);
      expect(((await byAdmin.json()) as any).owner.displayName).toBe('Owner');
      expect((await req('POST', base, admin, { name: 'X', ownerId: 99999 })).status).toBe(400);
    });

    test('validation: strict bodies, status values and date order', async () => {
      expect((await req('POST', base, owner, { name: '' })).status).toBe(400);
      expect((await req('POST', base, owner, { name: 'X', bogus: 1 })).status).toBe(400);
      expect((await req('POST', base, owner, { name: 'X', status: 'done' })).status).toBe(400);
      expect((await req('POST', base, owner, { name: 'X', startDate: '2026-05-02', targetDate: '2026-05-01' })).status).toBe(400);
      expect((await req('PUT', `${base}/${id}`, owner, { targetDate: '2025-01-01' })).status).toBe(400);
    });

    test('linking: needs browse on the epic or project (404), epics only (400), no duplicates (409)', async () => {
      expect((await req('POST', `${base}/${id}/links`, owner, { issueKey: 'TEST-1' })).status).toBe(201);
      expect((await req('POST', `${base}/${id}/links`, owner, { issueKey: 'TEST-1' })).status).toBe(409);
      expect((await req('POST', `${base}/${id}/links`, owner, { issueKey: 'TEST-2' })).status).toBe(400);
      expect((await req('POST', `${base}/${id}/links`, owner, { issueKey: 'SECR-1' })).status).toBe(404);
      expect((await req('POST', `${base}/${id}/links`, owner, { projectKey: 'SECR' })).status).toBe(404);
      expect((await req('POST', `${base}/${id}/links`, owner, { projectKey: 'NOPE' })).status).toBe(404);
      expect((await req('POST', `${base}/${id}/links`, owner, {})).status).toBe(400);
      expect((await req('POST', `${base}/${id}/links`, owner, { projectKey: 'TEST', issueKey: 'TEST-1' })).status).toBe(400);
      expect((await req('POST', `${base}/${id}/links`, member, { projectKey: 'TEST' })).status).toBe(403);
      expect((await req('POST', `${base}/${id}/links`, owner, { projectKey: 'TEST' })).status).toBe(201);
      expect((await req('POST', `${base}/${id}/links`, owner, { projectKey: 'TEST' })).status).toBe(409);
    });

    test('rollup: children of epics plus project issues, each once, cancelled excluded', async () => {
      const d = await json(req('GET', `${base}/${id}`, owner));
      // TEST-2 done, TEST-3 todo, TEST-5 todo; TEST-4 cancelled
      expect(d.progress).toMatchObject({ total: 3, done: 1, todo: 2, cancelled: 1, percentDone: 33, issueCount: 4 });
      expect(d.epics).toHaveLength(1);
      expect(d.epics[0]).toMatchObject({ key: 'TEST-1', project: { key: 'TEST' } });
      expect(d.epics[0].progress).toMatchObject({ total: 2, done: 1, percentDone: 50, cancelled: 1 });
      expect(d.projects[0]).toMatchObject({ key: 'TEST' });
      expect(d.projectCount).toBe(1);
      expect(d.epicCount).toBe(1);
    });

    test('permission trimming: hidden linked items are neither shown nor counted', async () => {
      expect((await req('POST', `${base}/${id}/links`, admin, { projectKey: 'SECR' })).status).toBe(201);
      expect((await req('POST', `${base}/${id}/links`, admin, { issueKey: 'SECR-1' })).status).toBe(201);
      const adminView = await json(req('GET', `${base}/${id}`, admin));
      expect(adminView.projectCount).toBe(2);
      expect(adminView.epicCount).toBe(2);
      expect(adminView.progress).toMatchObject({ total: 4, done: 2, percentDone: 50 });

      for (const cookie of [owner, member]) {
        const v = await json(req('GET', `${base}/${id}`, cookie));
        expect(v.projects.map((p: any) => p.key)).toEqual(['TEST']);
        expect(v.epics.map((e: any) => e.key)).toEqual(['TEST-1']);
        expect(v.projectCount).toBe(1);
        expect(v.epicCount).toBe(1);
        expect(v.progress).toMatchObject({ total: 3, done: 1, issueCount: 4 });
        expect(JSON.stringify(v)).not.toContain('SECR');
        expect(JSON.stringify(v)).not.toContain('Secret');
      }
      const list = await json(req('GET', base, member));
      expect(JSON.stringify(list)).not.toContain('SECR');
      expect(list.initiatives.find((i: any) => i.id === id).projectCount).toBe(1);
    });

    test('readable only with a visible linked item or as owner; hidden is 404, never 403', async () => {
      // an initiative that only links the secret project
      const created = await json(req('POST', base, admin, { name: 'Secret programme' }));
      secretOnly = created.id;
      expect((await req('POST', `${base}/${secretOnly}/links`, admin, { projectKey: 'SECR' })).status).toBe(201);
      expect((await req('GET', `${base}/${secretOnly}`, member)).status).toBe(404);
      expect((await req('PUT', `${base}/${secretOnly}`, member, { name: 'x' })).status).toBe(404);
      expect((await req('DELETE', `${base}/${secretOnly}`, member)).status).toBe(404);
      expect((await req('GET', `${base}/${secretOnly}/status-updates`, member)).status).toBe(404);
      expect((await req('GET', `${base}/99999`, member)).status).toBe(404);
      expect((await req('GET', `${base}/abc`, member)).status).toBe(404);
      expect((await json(req('GET', base, member))).initiatives.some((i: any) => i.id === secretOnly)).toBe(false);
      expect((await json(req('GET', base, admin))).initiatives.some((i: any) => i.id === secretOnly)).toBe(true);

      // outsiders see an initiative linked to TEST only if they can browse TEST
      expect((await req('GET', `${base}/${id}`, outsider)).status).toBe(404);
      expect((await json(req('GET', base, outsider))).initiatives).toEqual([]);

      // an own initiative without links is readable by its owner (and by admins) only
      const own = await json(req('POST', base, outsider, { name: 'Mine' }));
      expect((await req('GET', `${base}/${own.id}`, outsider)).status).toBe(200);
      expect((await req('GET', `${base}/${own.id}`, member)).status).toBe(404);
      expect((await req('GET', `${base}/${own.id}`, admin)).status).toBe(200);
    });

    test('edit and delete: owner or admin; other readers get 403', async () => {
      expect((await req('PUT', `${base}/${id}`, member, { name: 'Hijack' })).status).toBe(403);
      expect((await req('DELETE', `${base}/${id}`, member)).status).toBe(403);
      expect((await req('DELETE', `${base}/${id}/epics/TEST-1`, member)).status).toBe(403);
      const view = await json(req('GET', `${base}/${id}`, member));
      expect(view.canManage).toBe(false);

      const upd = await req('PUT', `${base}/${id}`, owner, { name: 'Launch 2026 (renamed)', status: 'completed', targetDate: '2026-11-30' });
      expect(upd.status).toBe(200);
      expect(await upd.json()).toMatchObject({ name: 'Launch 2026 (renamed)', status: 'completed', targetDate: '2026-11-30' });
      expect((await req('PUT', `${base}/${id}`, admin, { description: 'by admin', ownerId: ownerId })).status).toBe(200);
    });

    test('unlink: removes the link; unknown or invisible links are 404', async () => {
      expect((await req('DELETE', `${base}/${id}/epics/TEST-5`, owner)).status).toBe(404);
      expect((await req('DELETE', `${base}/${id}/projects/SECR`, owner)).status).toBe(404);
      expect((await req('DELETE', `${base}/${id}/projects/SECR`, admin)).status).toBe(200);
      expect((await req('DELETE', `${base}/${id}/epics/SECR-1`, admin)).status).toBe(200);
      expect((await req('DELETE', `${base}/${id}/projects/TEST`, owner)).status).toBe(200);
      const v = await json(req('GET', `${base}/${id}`, owner));
      expect(v.projects).toEqual([]);
      expect(v.epics).toHaveLength(1);
      // children of the epic only now
      expect(v.progress).toMatchObject({ total: 2, done: 1, percentDone: 50 });
    });

    test('status updates (health): owner posts, readers read, others cannot', async () => {
      const url = `${base}/${id}/status-updates`;
      expect(((await json(req('GET', url, member))).latest)).toBeNull();
      expect((await req('POST', url, member, { state: 'on_track' })).status).toBe(403);
      expect((await req('POST', url, owner, { state: 'green' })).status).toBe(400);
      expect((await req('POST', url, owner, { state: 'at_risk', extra: 1 })).status).toBe(400);
      const posted = await req('POST', url, owner, { state: 'at_risk', body: 'Vendor late' });
      expect(posted.status).toBe(201);
      expect(await posted.json()).toMatchObject({ state: 'at_risk', stateLabel: 'At risk', body: 'Vendor late', author: { displayName: 'Owner' } });
      expect((await req('POST', url, admin, { state: 'on_track' })).status).toBe(201);
      const hist = await json(req('GET', url, member));
      expect(hist.updates.map((u: any) => u.state)).toEqual(['on_track', 'at_risk']);
      expect(hist.latest.state).toBe('on_track');
      expect((await json(req('GET', `${base}/${id}`, member))).health.state).toBe('on_track');
      expect((await json(req('GET', base, member))).initiatives.find((i: any) => i.id === id).health.state).toBe('on_track');
      // initiative updates stay out of the project history and the projects badge
      const project = await json(req('GET', '/rest/api/2/project/TEST/status-updates', member));
      expect(project.updates).toEqual([]);
      expect((await json(req('GET', '/rest/api/2/status-updates/latest', member))).latest).toEqual({});
    });

    test('deleting removes the initiative and its updates', async () => {
      expect((await req('DELETE', `${base}/${id}`, owner)).status).toBe(200);
      expect((await req('GET', `${base}/${id}`, owner)).status).toBe(404);
      const left = await createTestDb(testSql).select().from(schema.projectStatusUpdates).where(eq(schema.projectStatusUpdates.initiativeId, id));
      expect(left).toEqual([]);
    });

    test('feature switch closes the API', async () => {
      expect((await req('PUT', '/rest/api/2/admin/features/initiatives', admin, { enabled: false })).status).toBe(200);
      invalidateFeatures();
      expect((await req('GET', base, admin)).status).toBe(404);
      expect((await req('POST', base, admin, { name: 'x' })).status).toBe(404);
      expect((await req('PUT', '/rest/api/2/admin/features/initiatives', admin, { enabled: true })).status).toBe(200);
      invalidateFeatures();
      expect((await req('GET', base, admin)).status).toBe(200);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('milestones', () => {
    const url = '/rest/api/2/project/TEST/milestones';
    let mid = 0;
    let secretMid = 0;

    test('permissions: browse to read, PROJECT_ADMIN to manage, 404 for hidden, 401 anonymous', async () => {
      expect((await app.request(url)).status).toBe(401);
      expect((await req('GET', url, outsider)).status).toBe(404);
      expect((await req('POST', url, outsider, { name: 'x' })).status).toBe(404);
      expect((await req('POST', url, member, { name: 'Beta' })).status).toBe(403);
      expect((await req('POST', url, owner, { name: 'Beta' })).status).toBe(403);
      expect((await req('GET', '/rest/api/2/project/NOPE/milestones', admin)).status).toBe(404);
      const res = await req('POST', url, pa, { name: 'Beta', description: 'Public beta', targetDate: '2026-06-30' });
      expect(res.status).toBe(201);
      const m = await res.json() as any;
      mid = m.id;
      expect(m).toMatchObject({ name: 'Beta', state: 'open', targetDate: '2026-06-30', progress: { total: 0, percentDone: 0 } });
      expect((await req('POST', url, pa, { name: 'Beta' })).status).toBe(409);
      expect((await req('POST', url, pa, { name: 'Bad', targetDate: '30/06/2026' })).status).toBe(400);
      expect((await req('POST', url, pa, { name: 'Bad', extra: true })).status).toBe(400);
      const list = await json(req('GET', url, member));
      expect(list.milestones).toHaveLength(1);
      expect(list.canManage).toBe(false);
      expect((await json(req('GET', url, pa))).canManage).toBe(true);
      expect((await req('POST', '/rest/api/2/project/SECR/milestones', admin, { name: 'Hidden' })).status).toBe(201);
      secretMid = (await json(req('GET', '/rest/api/2/project/SECR/milestones', admin))).milestones[0].id;
      expect((await req('GET', `/rest/api/2/project/SECR/milestones/${secretMid}`, member)).status).toBe(404);
    });

    test('linking issues needs EDIT_ISSUES and the same project', async () => {
      const link = (cookie: string, issueKey: string) => req('POST', `${url}/${mid}/issues`, cookie, { issueKey });
      expect((await link(member, 'TEST-2')).status).toBe(403);
      expect((await link(owner, 'TEST-2')).status).toBe(201);
      expect((await link(owner, 'TEST-3')).status).toBe(201);
      expect((await link(owner, 'TEST-4')).status).toBe(201);
      expect((await link(owner, 'TEST-3')).status).toBe(201); // idempotent
      expect((await link(owner, 'NOPE-1')).status).toBe(404);
      expect((await link(owner, 'SECR-2')).status).toBe(404); // cannot browse that project
      const other = await link(admin, 'SECR-2');
      expect(other.status).toBe(400);
      expect(JSON.stringify(await other.json())).toContain('own project');
      expect((await req('POST', `${url}/${mid}/issues`, owner, { issueKey: 'TEST-2', x: 1 })).status).toBe(400);
    });

    test('progress rolls up the linked issues and leaves cancelled out', async () => {
      const m = await json(req('GET', `${url}/${mid}`, member));
      expect(m.progress).toMatchObject({ total: 2, done: 1, todo: 1, cancelled: 1, percentDone: 50, issueCount: 3 });
      expect(m.issues.map((i: any) => i.key)).toEqual(['TEST-2', 'TEST-3', 'TEST-4']);
      expect(m.overdue).toBe(true); // target 2026-06-30 is in the past (today is later in 2026)
    });

    test('an issue can be in several milestones; the issue endpoint replaces the set but keeps to its own project', async () => {
      const second = await json(req('POST', url, pa, { name: 'GA', targetDate: '2999-01-01' }));
      const issueUrl = '/rest/api/2/issue/TEST-3/milestones';
      expect((await json(req('GET', issueUrl, member))).milestones.map((m: any) => m.name)).toEqual(['Beta']);
      expect((await req('PUT', issueUrl, member, { milestoneIds: [] })).status).toBe(403);
      expect((await req('PUT', issueUrl, outsider, { milestoneIds: [] })).status).toBe(404);
      expect((await req('PUT', issueUrl, owner, { milestoneIds: [mid, second.id] })).status).toBe(200);
      expect((await json(req('GET', issueUrl, member))).milestones.map((m: any) => m.name).sort()).toEqual(['Beta', 'GA']);
      const crossProject = await req('PUT', issueUrl, admin, { milestoneIds: [secretMid] });
      expect(crossProject.status).toBe(400);
      expect(JSON.stringify(await crossProject.json())).toContain('another project');
      expect((await req('PUT', issueUrl, admin, { milestoneIds: [987654] })).status).toBe(400);
      expect((await req('PUT', issueUrl, owner, { milestoneIds: [second.id] })).status).toBe(200);
      expect((await json(req('GET', `${url}/${mid}`, member))).issues.map((i: any) => i.key)).toEqual(['TEST-2', 'TEST-4']);
      expect((await req('DELETE', `${url}/${second.id}`, pa)).status).toBe(200);
      expect((await json(req('GET', issueUrl, member))).milestones).toEqual([]);
    });

    test('reaching and reopening, rename conflicts, unlink and delete', async () => {
      const reached = await json(req('PUT', `${url}/${mid}`, pa, { state: 'reached' }));
      expect(reached.state).toBe('reached');
      expect(reached.reachedAt).not.toBeNull();
      expect(reached.overdue).toBe(false);
      expect((await json(req('PUT', `${url}/${mid}`, pa, { state: 'open' }))).reachedAt).toBeNull();
      expect((await req('PUT', `${url}/${mid}`, member, { state: 'reached' })).status).toBe(403);
      expect((await req('PUT', `${url}/${mid}`, pa, { state: 'done' })).status).toBe(400);
      await req('POST', url, pa, { name: 'Other' });
      expect((await req('PUT', `${url}/${mid}`, pa, { name: 'Other' })).status).toBe(409);
      expect((await req('DELETE', `${url}/${mid}/issues/TEST-4`, member)).status).toBe(403);
      expect((await req('DELETE', `${url}/${mid}/issues/TEST-4`, owner)).status).toBe(200);
      expect((await req('DELETE', `${url}/${mid}/issues/TEST-4`, owner)).status).toBe(404);
      expect((await req('GET', `${url}/abc`, pa)).status).toBe(404);
    });

    test('JQL: milestone = / in / is EMPTY', async () => {
      const search = async (q: string, cookie = admin) => {
        const res = await app.request(`/rest/api/2/search?jql=${encodeURIComponent(q)}&maxResults=50`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        return ((await res.json()) as any).issues.map((i: any) => i.key).sort();
      };
      expect(await search('milestone = "Beta"')).toEqual(['TEST-2']);
      expect(await search('milestone = "beta"')).toEqual(['TEST-2']);
      expect(await search('milestone in ("Beta", "Nothing") AND project = TEST')).toEqual(['TEST-2']);
      expect(await search('project = TEST AND milestone is EMPTY')).toEqual(['TEST-1', 'TEST-3', 'TEST-4', 'TEST-5']);
      expect(await search('project = TEST AND milestone != "Beta"')).toEqual(['TEST-1', 'TEST-3', 'TEST-4', 'TEST-5']);
      expect(await search('milestone = "Beta"', outsider)).toEqual([]);
    });

    test('roadmap shows dated milestones; the feature switch removes them', async () => {
      const road = await json(req('GET', '/rest/agile/1.0/project/TEST/roadmap', member));
      const beta = road.milestones.find((m: any) => m.name === 'Beta');
      expect(beta).toMatchObject({ targetDate: '2026-06-30', state: 'open', percent: 100, issueCount: 1 });
      expect(road.milestones.every((m: any) => m.targetDate)).toBe(true); // undated ones are not drawn
      expect((await req('PUT', '/rest/api/2/project/TEST/features', admin, { features: { milestones: false } })).status).toBe(200);
      invalidateFeatures(); invalidateProjectFeatures();
      expect((await req('GET', url, admin)).status).toBe(404);
      expect((await req('GET', '/rest/api/2/issue/TEST-3/milestones', admin)).status).toBe(404);
      expect((await json(req('GET', '/rest/agile/1.0/project/TEST/roadmap', member))).milestones).toEqual([]);
      expect((await req('PUT', '/rest/api/2/project/TEST/features', admin, { features: { milestones: true } })).status).toBe(200);
      invalidateFeatures(); invalidateProjectFeatures();
      expect((await req('GET', url, admin)).status).toBe(200);
    });

    test('moving an issue to another project drops its milestones', async () => {
      const move = await req('POST', '/rest/api/2/issue/TEST-2/move', admin, { projectId: moveTargetId });
      expect(move.status).toBe(200);
      const m = await json(req('GET', `${url}/${mid}`, member));
      expect(m.issues).toEqual([]);
      expect(await createTestDb(testSql).select().from(schema.milestoneIssues).where(eq(schema.milestoneIssues.milestoneId, mid))).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('releases', () => {
    let versionId = 0;
    test('lists versions with issues, progress and open count; release uses the existing version rules', async () => {
      const db = createTestDb(testSql);
      const [v] = await db.insert(schema.versions).values({ projectId: seeded.project.id, name: '1.0', releaseDate: '2999-01-01' }).returning();
      versionId = v.id;
      const [t3] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-3'));
      const [t4] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-4'));
      const [t5] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-5'));
      await db.insert(schema.issueFixVersions).values([{ issueId: t3.id, versionId }, { issueId: t4.id, versionId }, { issueId: t5.id, versionId }]);

      expect((await app.request('/rest/api/2/project/TEST/releases')).status).toBe(401);
      expect((await req('GET', '/rest/api/2/project/TEST/releases', outsider)).status).toBe(404);
      expect((await req('GET', '/rest/api/2/project/NOPE/releases', admin)).status).toBe(404);

      const r = await json(req('GET', '/rest/api/2/project/TEST/releases', member));
      expect(r.canRelease).toBe(false);
      expect(r.versions).toHaveLength(1);
      expect(r.versions[0]).toMatchObject({ name: '1.0', released: false, overdue: false, openIssueCount: 2, progress: { total: 2, done: 0, cancelled: 1, issueCount: 3 } });
      expect(r.versions[0].issues.map((i: any) => i.key)).toEqual(['TEST-3', 'TEST-4', 'TEST-5']);

      const notes = await json(req('GET', `/rest/api/2/project/TEST/versions/${versionId}/release-notes?format=json`, member));
      expect(notes.version).toBe('1.0');

      // marking released is the existing PROJECT_ADMIN version update
      expect((await req('PUT', `/rest/api/2/project/TEST/versions/${versionId}`, member, { released: true })).status).toBe(403);
      expect((await req('PUT', `/rest/api/2/project/TEST/versions/${versionId}`, pa, { released: true, releaseDate: '2026-11-11' })).status).toBe(200);
      const after = await json(req('GET', '/rest/api/2/project/TEST/releases', pa));
      expect(after.canRelease).toBe(true);
      expect(after.versions[0]).toMatchObject({ released: true, releaseDate: '2026-11-11' });
    });

    test('archived versions are hidden unless asked for', async () => {
      await req('PUT', `/rest/api/2/project/TEST/versions/${versionId}`, pa, { archived: true });
      expect((await json(req('GET', '/rest/api/2/project/TEST/releases', pa))).versions).toEqual([]);
      expect((await json(req('GET', '/rest/api/2/project/TEST/releases?archived=true', pa))).versions).toHaveLength(1);
    });
  });
});
