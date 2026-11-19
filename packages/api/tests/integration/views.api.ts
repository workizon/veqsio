import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateFeatures } from '../../src/features';

describe('Saved views', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let groupId: number;
  let otherId: number;
  let users: Record<string, any> = {};
  const cookies: Record<string, string> = {};
  const call = (who: string | null, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: cookies[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) });
    cookies[username] = (res.headers.get('set-cookie') || '').split(';')[0];
  };
  const cfg = (patch: Record<string, unknown> = {}) => ({ ...patch });
  const create = async (who: string, body: Record<string, unknown>) => {
    const res = await call(who, 'POST', '/rest/api/2/views', { name: 'V', config: {}, ...body });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return (await res.json()) as any;
  };
  const mkIssue = async (who: string, projectId: number, summary: string, extra: Record<string, unknown> = {}) => {
    const res = await call(who, 'POST', '/rest/api/2/issue', { fields: { project: { id: projectId }, issuetype: { id: seeded.issueType.id }, summary, priority: { id: seeded.priority.id }, ...extra } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    process.env.VIEWS_EXPORT_MAX_ROWS = '10000';
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = async (username: string) => (await db.insert(schema.users).values({ username, email: `${username}@example.com`, displayName: username, passwordHash: hash }).returning())[0];
    users = { admin: seeded.user, alice: await mk('alice'), carol: await mk('carol'), bob: await mk('bob'), dave: await mk('dave') };

    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTHER', name: 'Other', leadId: seeded.user.id }).returning();
    otherId = other.id;
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'Other scheme' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: other.id, schemeId: scheme.id });
    const dev = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES'];
    await db.insert(schema.permissionEntries).values([
      ...dev.map((p) => ({ schemeId: scheme.id, permissionKey: p, userId: users.alice.id })),
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: users.carol.id },
      // dave browses the seeded TEST project through his group only
    ]);
    const [wfAssoc] = await db.select().from(schema.workflowSchemeAssociations).limit(1);
    await db.insert(schema.workflowSchemeAssociations).values({ projectId: other.id, schemeId: wfAssoc.schemeId });

    const [g] = await db.insert(schema.groups).values({ name: 'viewers' }).returning();
    groupId = g.id;
    await db.insert(schema.userGroups).values({ userId: users.dave.id, groupId });

    for (const u of ['admin', 'alice', 'carol', 'bob', 'dave']) await login(u);

    await mkIssue('admin', seeded.project.id, 'Secret TEST issue');
    await mkIssue('admin', seeded.project.id, '=HYPERLINK("http://evil","click")');
    await mkIssue('admin', seeded.project.id, 'Comma, "quoted" summary', { labels: ['red', 'blue'] });
    await mkIssue('alice', other.id, 'Visible OTHER issue', { labels: ['red'] });
    await mkIssue('alice', other.id, 'Second OTHER issue');
  });
  afterAll(async () => {
    delete process.env.VIEWS_EXPORT_MAX_ROWS;
    invalidateFeatures();
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('every endpoint needs a session', async () => {
    for (const [m, p] of [
      ['GET', '/rest/api/2/views'], ['POST', '/rest/api/2/views'], ['GET', '/rest/api/2/views/1'], ['PUT', '/rest/api/2/views/1'],
      ['DELETE', '/rest/api/2/views/1'], ['GET', '/rest/api/2/views/1/issues'], ['GET', '/rest/api/2/views/1/export?format=csv'],
      ['POST', '/rest/api/2/views/1/duplicate'], ['PUT', '/rest/api/2/views/1/favourite'], ['POST', '/rest/api/2/views/execute'],
      ['POST', '/rest/api/2/views/export'], ['GET', '/rest/api/2/views/builtin/all-work'], ['GET', '/rest/api/2/views/builtin/all-work/issues'],
      ['GET', '/rest/api/2/views/builtin/all-work/export?format=csv'], ['POST', '/rest/api/2/views/builtin/all-work/duplicate'],
      ['PUT', '/rest/api/2/views/builtin/all-work/favourite'],
    ]) {
      expect((await call(null, m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(401);
    }
  });

  describe('CRUD and validation', () => {
    test('create, read, update, delete as the owner', async () => {
      const v = await create('alice', {
        name: '  My bugs  ', description: 'desc',
        config: cfg({ query: { jql: 'project = OTHER' }, layout: 'table', columns: ['key', 'summary'], groupBy: 'status', sort: [{ field: 'created', direction: 'desc' }] }),
      });
      expect(v).toMatchObject({ name: 'My bugs', builtin: false, editable: true, favourite: false, layout: 'table', shared: false });
      expect(v.config).toMatchObject({ layout: 'table', columns: ['key', 'summary'], groupBy: 'status', subGroupBy: 'none', showEmptyGroups: false });
      expect(v.shares).toEqual([]);

      const got = await (await call('alice', 'GET', `/rest/api/2/views/${v.id}`)).json();
      expect(got.config.query.jql).toBe('project = OTHER');

      const upd = await call('alice', 'PUT', `/rest/api/2/views/${v.id}`, { name: 'Renamed', config: cfg({ layout: 'board', groupBy: 'assignee', subGroupBy: 'priority', showEmptyGroups: true }) });
      expect(upd.status).toBe(200);
      const after = await upd.json();
      expect(after.name).toBe('Renamed');
      expect(after.config).toMatchObject({ layout: 'board', groupBy: 'assignee', subGroupBy: 'priority', showEmptyGroups: true });
      expect(after.config.query.jql).toBe(''); // config is replaced as a whole

      expect((await call('alice', 'DELETE', `/rest/api/2/views/${v.id}`)).status).toBe(200);
      expect((await call('alice', 'GET', `/rest/api/2/views/${v.id}`)).status).toBe(404);
    });

    test('strict validation', async () => {
      const bad = async (body: unknown) => (await call('alice', 'POST', '/rest/api/2/views', body)).status;
      expect(await bad({ name: '', config: {} })).toBe(400);
      expect(await bad({ name: 'x', config: { layout: 'gantt' } })).toBe(400);
      expect(await bad({ name: 'x', config: { unknown: 1 } })).toBe(400);
      expect(await bad({ name: 'x', config: {}, extra: true })).toBe(400);
      expect(await bad({ name: 'x', config: { groupBy: 'project' } })).toBe(400);
      expect(await bad({ name: 'x', config: { columns: ['key', 'password'] } })).toBe(400);
      expect(await bad({ name: 'x', config: { sort: [{ field: 'key', direction: 'asc' }, { field: 'summary', direction: 'asc' }, { field: 'type', direction: 'asc' }, { field: 'status', direction: 'asc' }] } })).toBe(400);
      expect(await bad({ name: 'x', config: { query: { jql: 'x'.repeat(5001) } } })).toBe(400);
      expect(await bad({ name: 'x', config: { query: { filters: { statuses: 'Done' } } } })).toBe(400);
      expect(await bad({ name: 'x', config: {}, shares: [{ type: 'world' }] })).toBe(400);
      expect(await bad({ config: {} })).toBe(400);
      const jql = await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: { query: { jql: 'nosuchfield = 1' } } });
      expect(jql.status).toBe(400);
      expect((await jql.json()).errorMessages[0]).toContain('Invalid JQL');
      expect((await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: { query: { jql: 'status = (' } } })).status).toBe(400);
      expect((await call('alice', 'PUT', '/rest/api/2/views/1', { bogus: 1 })).status).toBe(404); // hidden before validation
    });

    test('numeric id guard and unknown ids', async () => {
      for (const id of ['abc', '0', '-1', '99999999999', '1.5']) {
        expect((await call('alice', 'GET', `/rest/api/2/views/${id}`)).status, id).toBe(404);
        expect((await call('alice', 'DELETE', `/rest/api/2/views/${id}`)).status, id).toBe(404);
        expect((await call('alice', 'GET', `/rest/api/2/views/${id}/issues`)).status, id).toBe(404);
      }
      expect((await call('alice', 'GET', '/rest/api/2/views/987654')).status).toBe(404);
    });

    test('shares must point at real targets the sharer may use', async () => {
      expect((await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: {}, shares: [{ type: 'user', id: 9999999 }] })).status).toBe(400);
      expect((await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: {}, shares: [{ type: 'group', id: groupId }] })).status).toBe(400); // not a member
      expect((await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: {}, shares: [{ type: 'project', id: seeded.project.id }] })).status).toBe(400); // cannot browse TEST
      const ok = await call('alice', 'POST', '/rest/api/2/views', { name: 'x', config: {}, shares: [{ type: 'project', id: otherId }, { type: 'project', id: otherId }] });
      expect(ok.status).toBe(201);
      expect((await ok.json()).shares).toEqual([{ type: 'project', id: otherId }]);
    });
  });

  describe('sharing and visibility', () => {
    let id: string;
    test('private views are invisible to others (404, not 403) and to list/search', async () => {
      const v = await create('alice', { name: 'Alice private zebra', config: {} });
      id = v.id;
      for (const who of ['carol', 'bob', 'dave']) {
        expect((await call(who, 'GET', `/rest/api/2/views/${id}`)).status).toBe(404);
        expect((await call(who, 'GET', `/rest/api/2/views/${id}/issues`)).status).toBe(404);
        expect((await call(who, 'GET', `/rest/api/2/views/${id}/export?format=csv`)).status).toBe(404);
        expect((await call(who, 'PUT', `/rest/api/2/views/${id}`, { name: 'hijack' })).status).toBe(404);
        expect((await call(who, 'DELETE', `/rest/api/2/views/${id}`)).status).toBe(404);
        expect((await call(who, 'POST', `/rest/api/2/views/${id}/duplicate`, {})).status).toBe(404);
        expect((await call(who, 'PUT', `/rest/api/2/views/${id}/favourite`, { favourite: true })).status).toBe(404);
        const list = await (await call(who, 'GET', '/rest/api/2/views?search=zebra')).json();
        expect(list.values).toHaveLength(0);
      }
      // administrators can open everything
      expect((await call('admin', 'GET', `/rest/api/2/views/${id}`)).status).toBe(200);
    });

    test('shared with a project: only members who can browse it', async () => {
      expect((await call('alice', 'PUT', `/rest/api/2/views/${id}`, { shares: [{ type: 'project', id: otherId }] })).status).toBe(200);
      expect((await call('carol', 'GET', `/rest/api/2/views/${id}`)).status).toBe(200);
      expect((await call('bob', 'GET', `/rest/api/2/views/${id}`)).status).toBe(404);
      expect((await call('dave', 'GET', `/rest/api/2/views/${id}`)).status).toBe(404);
      const seen = await (await call('carol', 'GET', '/rest/api/2/views?search=zebra&scope=shared')).json();
      expect(seen.values.map((x: any) => x.name)).toEqual(['Alice private zebra']);
      expect(seen.values[0]).toMatchObject({ editable: false, shared: true });
      expect(seen.values[0].shares).toBeUndefined(); // sharing details only for managers
    });

    test('shared with a group and with a user', async () => {
      const mine = await create('admin', { name: 'Group zebra', config: {}, shares: [{ type: 'group', id: groupId }] });
      expect((await call('dave', 'GET', `/rest/api/2/views/${mine.id}`)).status).toBe(200);
      expect((await call('bob', 'GET', `/rest/api/2/views/${mine.id}`)).status).toBe(404);
      const u = await create('admin', { name: 'User zebra', config: {}, shares: [{ type: 'user', id: users.bob.id }] });
      expect((await call('bob', 'GET', `/rest/api/2/views/${u.id}`)).status).toBe(200);
      expect((await call('carol', 'GET', `/rest/api/2/views/${u.id}`)).status).toBe(404);
    });

    test('shared with everybody; only the owner or an admin changes it', async () => {
      const g = await create('alice', { name: 'Global zebra', config: {}, shares: [{ type: 'global' }] });
      for (const who of ['bob', 'carol', 'dave']) expect((await call(who, 'GET', `/rest/api/2/views/${g.id}`)).status).toBe(200);
      for (const who of ['bob', 'carol']) {
        expect((await call(who, 'PUT', `/rest/api/2/views/${g.id}`, { name: 'x' })).status).toBe(403);
        expect((await call(who, 'DELETE', `/rest/api/2/views/${g.id}`)).status).toBe(403);
      }
      expect((await call('admin', 'PUT', `/rest/api/2/views/${g.id}`, { name: 'Global zebra (admin)' })).status).toBe(200);
      expect((await call('alice', 'PUT', `/rest/api/2/views/${g.id}`, { shares: [] })).status).toBe(200);
      expect((await call('bob', 'GET', `/rest/api/2/views/${g.id}`)).status).toBe(404); // unshared again
    });

    test('list scopes and search', async () => {
      const mineList = await (await call('alice', 'GET', '/rest/api/2/views?scope=mine&search=zebra')).json();
      expect(mineList.values.every((v: any) => v.owner.id === users.alice.id)).toBe(true);
      expect(mineList.values.length).toBeGreaterThanOrEqual(2);
      const shared = await (await call('bob', 'GET', '/rest/api/2/views?scope=shared&search=zebra')).json();
      expect(shared.values.map((v: any) => v.name)).toEqual(['User zebra']);
      expect((await call('bob', 'GET', '/rest/api/2/views?scope=bogus')).status).toBe(400);
      expect((await call('bob', 'GET', '/rest/api/2/views?all=true')).status).toBe(403);
      const all = await (await call('admin', 'GET', '/rest/api/2/views?all=true&search=zebra')).json();
      expect(all.total).toBeGreaterThanOrEqual(4);
      // search is literal: % and _ are not wildcards
      expect((await (await call('admin', 'GET', '/rest/api/2/views?all=true&search=%25')).json()).values).toHaveLength(0);
    });
  });

  describe('built-in views, favourites, duplicate', () => {
    test('four generated built-in views, listed first, not editable or deletable', async () => {
      const list = await (await call('bob', 'GET', '/rest/api/2/views')).json();
      expect(list.builtin.map((b: any) => b.id)).toEqual(['builtin:all-work', 'builtin:assigned-to-me', 'builtin:created-by-me', 'builtin:recently-updated']);
      expect(list.builtin.map((b: any) => b.name)).toEqual(['All work', 'Assigned to me', 'Created by me', 'Recently updated']);
      expect(list.builtin.every((b: any) => b.builtin && !b.editable)).toBe(true);
      const q = await (await call('bob', 'GET', '/rest/api/2/views?search=recent')).json();
      expect(q.builtin.map((b: any) => b.name)).toEqual(['Recently updated']);
      expect((await call('bob', 'GET', '/rest/api/2/views/builtin/nope')).status).toBe(404);
      for (const m of ['PUT', 'DELETE']) expect((await call('admin', m, '/rest/api/2/views/builtin/all-work', { name: 'x' })).status).toBe(404);
      expect((await db.select().from(schema.views).where(eq(schema.views.name, 'All work'))).length).toBe(0);
    });

    test('built-ins execute as the viewer', async () => {
      const mine = await (await call('alice', 'GET', '/rest/api/2/views/builtin/created-by-me/issues')).json();
      expect(mine.total).toBe(2);
      expect(mine.issues.every((i: any) => i.fields.reporter.displayName === 'alice')).toBe(true);
      const assigned = await (await call('bob', 'GET', '/rest/api/2/views/builtin/assigned-to-me/issues')).json();
      expect(assigned.total).toBe(0);
      const recent = await (await call('alice', 'GET', '/rest/api/2/views/builtin/recently-updated/issues')).json();
      expect(recent.total).toBe(2);
      const allWork = await (await call('admin', 'GET', '/rest/api/2/views/builtin/all-work/issues')).json();
      expect(allWork.total).toBe(5);
    });

    test('favourites (per user, also for built-ins and shared views) and duplicate', async () => {
      const g = await create('alice', { name: 'Fav zebra', config: {}, shares: [{ type: 'global' }] });
      expect((await (await call('bob', 'PUT', `/rest/api/2/views/${g.id}/favourite`, { favourite: true })).json())).toEqual({ id: g.id, favourite: true });
      expect((await call('bob', 'PUT', `/rest/api/2/views/${g.id}/favourite`, { favourite: 'yes' })).status).toBe(400);
      expect((await (await call('bob', 'GET', `/rest/api/2/views/${g.id}`)).json()).favourite).toBe(true);
      expect((await (await call('alice', 'GET', `/rest/api/2/views/${g.id}`)).json()).favourite).toBe(false);
      expect((await call('bob', 'PUT', '/rest/api/2/views/builtin/created-by-me/favourite', { favourite: true })).status).toBe(200);
      const favs = await (await call('bob', 'GET', '/rest/api/2/views?scope=favourites')).json();
      expect(favs.values.map((v: any) => v.id)).toEqual([g.id]);
      expect(favs.builtin.map((b: any) => b.id)).toEqual(['builtin:created-by-me']);
      expect((await call('bob', 'PUT', `/rest/api/2/views/${g.id}/favourite`, { favourite: false })).status).toBe(200);
      expect((await (await call('bob', 'GET', '/rest/api/2/views?scope=favourites')).json()).values).toHaveLength(0);

      const dup = await call('bob', 'POST', `/rest/api/2/views/${g.id}/duplicate`, {});
      expect(dup.status).toBe(201);
      const copy = await dup.json();
      expect(copy).toMatchObject({ name: 'Copy of Fav zebra', editable: true, shared: false });
      expect(copy.owner.id).toBe(users.bob.id);
      const bdup = await (await call('bob', 'POST', '/rest/api/2/views/builtin/all-work/duplicate', { name: 'Mine now' })).json();
      expect(bdup).toMatchObject({ name: 'Mine now', builtin: false, editable: true });
      expect(bdup.config.sort).toEqual([{ field: 'created', direction: 'desc' }]);

      // deleting a view removes everybody's favourite of it
      await call('bob', 'PUT', `/rest/api/2/views/${g.id}/favourite`, { favourite: true });
      expect((await call('alice', 'DELETE', `/rest/api/2/views/${g.id}`)).status).toBe(200);
      expect((await db.select().from(schema.viewFavourites).where(eq(schema.viewFavourites.viewKey, g.id))).length).toBe(0);
    });
  });

  describe('execution as the viewer (permission trimming)', () => {
    let shared: any;
    beforeAll(async () => {
      shared = await create('admin', { name: 'Everything', config: cfg({ columns: ['key', 'summary', 'labels'] }), shares: [{ type: 'global' }] });
    });

    test('a shared view never reveals issues the viewer cannot browse', async () => {
      const asAdmin = await (await call('admin', 'GET', `/rest/api/2/views/${shared.id}/issues`)).json();
      expect(asAdmin.total).toBe(5);
      const asCarol = await (await call('carol', 'GET', `/rest/api/2/views/${shared.id}/issues`)).json();
      expect(asCarol.total).toBe(2);
      expect(asCarol.issues.map((i: any) => i.fields.project.key)).toEqual(['OTHER', 'OTHER']);
      expect(JSON.stringify(asCarol)).not.toContain('Secret TEST issue');
      const asBob = await (await call('bob', 'GET', `/rest/api/2/views/${shared.id}/issues`)).json();
      expect(asBob.total).toBe(0);
      expect(asBob.issues).toEqual([]);
      expect(asBob.groups).toEqual([]);
    });

    test('a query that names a hidden project returns nothing, ad-hoc too', async () => {
      const r = await (await call('carol', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { jql: 'project = TEST' } }) })).json();
      expect(r.total).toBe(0);
      const f = await (await call('carol', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { filters: { projects: ['TEST'] } } }) })).json();
      expect(f.total).toBe(0);
      const text = await (await call('carol', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { filters: { text: 'Secret' } } }) })).json();
      expect(text.total).toBe(0);
    });

    test('jql + simple filters are combined with AND; JQL ORDER BY is honoured; view sort wins', async () => {
      const r = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { jql: 'project = TEST ORDER BY summary DESC', filters: { labels: ['red'] } } }) })).json();
      expect(r.total).toBe(1);
      expect(r.issues[0].fields.summary).toBe('Comma, "quoted" summary');
      const byJql = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { jql: 'project = TEST ORDER BY summary ASC' } }) })).json();
      expect(byJql.issues.map((i: any) => i.fields.summary)).toEqual(['=HYPERLINK("http://evil","click")', 'Comma, "quoted" summary', 'Secret TEST issue']);
      const bySort = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { jql: 'project = TEST ORDER BY summary ASC' }, sort: [{ field: 'summary', direction: 'desc' }] }) })).json();
      expect(bySort.issues.map((i: any) => i.fields.summary)).toEqual(['Secret TEST issue', 'Comma, "quoted" summary', '=HYPERLINK("http://evil","click")']);
      const byKey = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ sort: [{ field: 'key', direction: 'asc' }] }) })).json();
      expect(byKey.issues.map((i: any) => i.key)).toEqual(['OTHER-1', 'OTHER-2', 'TEST-1', 'TEST-2', 'TEST-3']);
    });

    test('execution errors are 400, bad bodies are 400', async () => {
      expect((await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ query: { jql: 'nosuchfield = 1' } }) })).status).toBe(400);
      expect((await call('admin', 'POST', '/rest/api/2/views/execute', { config: {}, maxResults: 100000 })).status).toBe(400);
      expect((await call('admin', 'POST', '/rest/api/2/views/execute', { config: {}, startAt: -1 })).status).toBe(400);
      expect((await call('admin', 'POST', '/rest/api/2/views/execute', {})).status).toBe(400);
    });

    test('paging and grouping metadata', async () => {
      const p1 = await (await call('admin', 'GET', `/rest/api/2/views/${shared.id}/issues?startAt=0&maxResults=2`)).json();
      expect(p1).toMatchObject({ startAt: 0, maxResults: 2, total: 5 });
      expect(p1.issues).toHaveLength(2);
      const p3 = await (await call('admin', 'GET', `/rest/api/2/views/${shared.id}/issues?startAt=4&maxResults=2`)).json();
      expect(p3.issues).toHaveLength(1);
      expect((await (await call('admin', 'GET', `/rest/api/2/views/${shared.id}/issues?maxResults=999999`)).json()).maxResults).toBe(500);

      const g = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ groupBy: 'label', subGroupBy: 'status' }) })).json();
      expect(g).toMatchObject({ groupBy: 'label', subGroupBy: 'status', total: 5 });
      const byLabel = Object.fromEntries(g.groups.map((x: any) => [x.label, x]));
      expect(byLabel.red.count).toBe(2);
      expect(byLabel.blue.count).toBe(1);
      expect(byLabel['No label'].count).toBe(3);
      expect(g.groups[g.groups.length - 1].label).toBe('No label');
      expect(byLabel.red.subGroups[0].label).toBe('To Do');
      const ids = new Set(g.issues.map((i: any) => i.id));
      for (const x of g.groups) for (const id of x.issueIds) expect(ids.has(id)).toBe(true);
    });

    test('show empty groups adds statuses with no issues', async () => {
      const noEmpty = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ groupBy: 'status' }) })).json();
      expect(noEmpty.groups.map((x: any) => x.label)).toEqual(['To Do']);
      const withEmpty = await (await call('admin', 'POST', '/rest/api/2/views/execute', { config: cfg({ groupBy: 'status', showEmptyGroups: true }) })).json();
      expect(withEmpty.groups.map((x: any) => [x.label, x.count])).toEqual([['To Do', 5], ['In Progress', 0]]);
    });

    test('sprint is attached for group by sprint', async () => {
      const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: otherId } as any).returning();
      const [sprint] = await db.insert(schema.sprints).values({ name: 'Sprint 1', state: 'active', boardId: board.id }).returning();
      const [first] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'OTHER-1'));
      await db.insert(schema.sprintIssues).values({ sprintId: sprint.id, issueId: first.id });
      const g = await (await call('alice', 'POST', '/rest/api/2/views/execute', { config: cfg({ groupBy: 'sprint' }) })).json();
      expect(g.groups.map((x: any) => [x.label, x.count])).toEqual([['Sprint 1', 1], ['No sprint', 1]]);
      expect(g.issues.find((i: any) => i.key === 'OTHER-1').fields.sprint).toMatchObject({ name: 'Sprint 1', state: 'active' });
    });
  });

  describe('export', () => {
    function unzip(buf: Uint8Array): Map<string, string> {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const eocd = buf.length - 22;
      expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
      const count = dv.getUint16(eocd + 10, true);
      let p = dv.getUint32(eocd + 16, true);
      const out = new Map<string, string>();
      for (let n = 0; n < count; n++) {
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nlen = dv.getUint16(p + 28, true);
        const off = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
        const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
        const raw = buf.subarray(start, start + csize);
        out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw));
        p += 46 + nlen;
      }
      return out;
    }
    let view: any;
    beforeAll(async () => {
      view = await create('admin', {
        name: 'Export "me"/now', config: cfg({ columns: ['key', 'summary', 'labels', 'status'], sort: [{ field: 'key', direction: 'asc' }] }),
        shares: [{ type: 'global' }],
      });
    });

    test('CSV: headers, rows in view order, formula-injection safe, quoting', async () => {
      const res = await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Export-me-now-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-export-rows')).toBe('5');
      expect(res.headers.get('x-export-truncated')).toBe('false');
      const lines = (await res.text()).split('\r\n');
      expect(lines[0]).toBe('Key,Summary,Labels,Status');
      expect(lines[1]).toBe('OTHER-1,Visible OTHER issue,red,To Do');
      expect(lines.some((l) => l.startsWith(`TEST-2,"'=HYPERLINK(""http://evil"",""click"")"`))).toBe(true);
      expect(lines.some((l) => l.includes('"Comma, ""quoted"" summary"') && l.includes('"red, blue"'))).toBe(true);
      expect(lines.some((l) => /^[=+@-]/.test(l))).toBe(false);
      expect(lines[lines.length - 1]).toBe('');
    });

    test('permissions are respected by every format and every route', async () => {
      for (const fmt of ['csv', 'json', 'xlsx']) {
        const res = await call('carol', 'GET', `/rest/api/2/views/${view.id}/export?format=${fmt}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-export-rows')).toBe('2');
        const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
        expect(body).not.toContain('Secret TEST');
        if (fmt === 'xlsx') {
          const sheet = unzip(new Uint8Array(Buffer.from(body, 'latin1'))).get('xl/worksheets/sheet1.xml')!;
          expect(sheet).not.toContain('Secret TEST');
          expect(sheet).toContain('Visible OTHER issue');
        }
      }
      const adhoc = await call('carol', 'POST', '/rest/api/2/views/export', { config: cfg({ query: { jql: 'project = TEST' } }), format: 'csv' });
      expect(adhoc.status).toBe(200);
      expect(adhoc.headers.get('x-export-rows')).toBe('0');
      expect((await adhoc.text()).replace('\uFEFF', '').trim()).toBe('Key,Summary,Type,Status,Priority,Assignee,Updated');
      expect((await call('bob', 'GET', `/rest/api/2/views/${view.id}/export?format=csv`)).headers.get('x-export-rows')).toBe('0');
    });

    test('JSON: valid document with metadata and typed values', async () => {
      const res = await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=json`);
      expect(res.headers.get('content-type')).toContain('application/json');
      const doc = await res.json();
      expect(doc).toMatchObject({ view: 'Export "me"/now', count: 5, truncated: false, columns: ['key', 'summary', 'labels', 'status'] });
      expect(doc.issues).toHaveLength(5);
      expect(doc.issues[0]).toEqual({ key: 'OTHER-1', summary: 'Visible OTHER issue', labels: ['red'], status: 'To Do' });
      expect(doc.issues.find((i: any) => i.key === 'TEST-2').summary).toBe('=HYPERLINK("http://evil","click")'); // JSON keeps raw text
    });

    test('XLSX: valid archive, neutralised formula text, header row', async () => {
      const res = await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=xlsx`);
      expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(res.headers.get('content-disposition')).toContain('.xlsx"');
      const files = unzip(new Uint8Array(await res.arrayBuffer()));
      expect(files.has('xl/workbook.xml')).toBe(true);
      const sheet = files.get('xl/worksheets/sheet1.xml')!;
      expect(sheet).toContain('>Key</t>');
      expect(sheet).toContain("'=HYPERLINK(&quot;http://evil&quot;,&quot;click&quot;)");
      expect(sheet).not.toContain('<f>');
      expect(sheet.match(/<row /g)!.length).toBe(6);
    });

    test('built-in and ad-hoc export; format validation', async () => {
      const b = await call('alice', 'GET', '/rest/api/2/views/builtin/created-by-me/export?format=csv');
      expect(b.status).toBe(200);
      expect(b.headers.get('x-export-rows')).toBe('2');
      expect((await call('alice', 'GET', '/rest/api/2/views/builtin/created-by-me/export?format=pdf')).status).toBe(400);
      expect((await call('alice', 'GET', '/rest/api/2/views/builtin/created-by-me/export')).status).toBe(400);
      expect((await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=xml`)).status).toBe(400);
      expect((await call('alice', 'GET', '/rest/api/2/views/builtin/nope/export?format=csv')).status).toBe(404);
      const adhoc = await call('admin', 'POST', '/rest/api/2/views/export', { config: cfg({ query: { jql: 'project = OTHER' }, columns: ['key'] }), format: 'json', name: 'Search result' });
      expect((await adhoc.json())).toMatchObject({ view: 'Search result', count: 2 });
      expect((await call('admin', 'POST', '/rest/api/2/views/export', { config: {}, format: 'doc' })).status).toBe(400);
      expect((await call('admin', 'POST', '/rest/api/2/views/export', { config: { query: { jql: 'bad bad' } }, format: 'csv' })).status).toBe(400);
    });

    test('the row cap truncates and says so', async () => {
      process.env.VIEWS_EXPORT_MAX_ROWS = '3';
      try {
        const res = await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=csv`);
        expect(res.headers.get('x-export-rows')).toBe('3');
        expect(res.headers.get('x-export-truncated')).toBe('true');
        expect((await res.text()).trim().split('\r\n')).toHaveLength(4);
        const json = await (await call('admin', 'GET', `/rest/api/2/views/${view.id}/export?format=json`)).json();
        expect(json).toMatchObject({ count: 3, truncated: true });
        expect(json.issues).toHaveLength(3);
      } finally {
        process.env.VIEWS_EXPORT_MAX_ROWS = '10000';
      }
    });

    test('exports are written to the audit log without issue content', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'VIEW_EXPORTED'));
      expect(rows.length).toBeGreaterThanOrEqual(5);
      const mine = rows.find((r) => r.actorName === 'carol')!;
      expect(mine.targetType).toBe('view');
      expect(mine.details).toMatchObject({ format: expect.any(String), rows: expect.any(Number) });
      expect(JSON.stringify(rows)).not.toContain('Secret TEST');
    });
  });

  describe('feature switch', () => {
    test('switching "views" off closes every route and on restores them', async () => {
      const v = await create('alice', { name: 'Switch me', config: {} });
      expect((await call('admin', 'PUT', '/rest/api/2/admin/features/views', { enabled: false })).status).toBe(200);
      invalidateFeatures();
      try {
        for (const [m, p] of [
          ['GET', '/rest/api/2/views'], ['GET', `/rest/api/2/views/${v.id}`], ['GET', `/rest/api/2/views/${v.id}/issues`],
          ['GET', `/rest/api/2/views/${v.id}/export?format=csv`], ['GET', '/rest/api/2/views/builtin/all-work/issues'],
          ['POST', '/rest/api/2/views/execute'], ['POST', '/rest/api/2/views/export'],
        ]) {
          expect((await call('alice', m, p, m === 'POST' ? { config: {}, format: 'csv' } : undefined)).status, `${m} ${p}`).toBe(404);
        }
        expect((await call('alice', 'GET', '/rest/api/2/filter')).status).toBe(200); // saved filters are untouched
        const feats = await (await call('alice', 'GET', '/rest/api/2/features')).json();
        expect(feats.features.find((f: any) => f.id === 'views').enabled).toBe(false);
      } finally {
        await call('admin', 'PUT', '/rest/api/2/admin/features/views', { enabled: true });
        invalidateFeatures();
      }
      expect((await call('alice', 'GET', `/rest/api/2/views/${v.id}`)).status).toBe(200); // data is untouched
    });
  });
});
