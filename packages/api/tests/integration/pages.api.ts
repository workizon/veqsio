import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateFeatures } from '../../src/features';

describe('Wiki / Pages', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const cookies: Record<string, string> = {};
  const call = (who: string | null, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: cookies[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = async (who: string, body: Record<string, unknown>) => {
    const res = await call(who, 'POST', '/rest/api/2/pages', body);
    expect(res.status).toBe(201);
    return (await res.json()).id as number;
  };
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) });
    cookies[username] = (res.headers.get('set-cookie') || '').split(';')[0];
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = async (username: string) => (await db.insert(schema.users).values({ username, email: `${username}@example.com`, displayName: username, passwordHash: hash }).returning())[0];
    const alice = await mk('alice'); // developer in OTHER
    const dave = await mk('dave'); // developer in OTHER
    const carol = await mk('carol'); // only browses OTHER
    await mk('bob'); // no project rights at all

    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTHER', name: 'Other', leadId: seeded.user.id }).returning();
    const [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'Other scheme' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: other.id, schemeId: scheme.id });
    const dev = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'ADD_COMMENTS'];
    await db.insert(schema.permissionEntries).values([
      ...[alice, dave].flatMap((u) => dev.map((p) => ({ schemeId: scheme.id, permissionKey: p, userId: u.id }))),
      { schemeId: scheme.id, permissionKey: 'BROWSE_PROJECTS', userId: carol.id },
    ]);
    const [wfAssoc] = await db.select().from(schema.workflowSchemeAssociations).limit(1);
    await db.insert(schema.workflowSchemeAssociations).values({ projectId: other.id, schemeId: wfAssoc.schemeId });

    for (const u of ['admin', 'alice', 'dave', 'carol', 'bob']) await login(u);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('every endpoint needs a session', async () => {
    for (const [m, p] of [['GET', '/rest/api/2/pages'], ['POST', '/rest/api/2/pages'], ['GET', '/rest/api/2/pages/1'], ['GET', '/rest/api/2/pages/search?q=ab'], ['GET', '/rest/api/2/pages/1/versions'], ['POST', '/rest/api/2/pages/1/convert-to-issue']]) {
      expect((await call(null, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(401);
    }
  });

  describe('workspace pages', () => {
    let id: number;
    test('any signed-in user creates one and everybody signed in reads it', async () => {
      id = await create('bob', { title: 'Handbook', body: '# Welcome\n\nHello PROJ-1' });
      const res = await call('carol', 'GET', `/rest/api/2/pages/${id}`);
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page).toMatchObject({ title: 'Handbook', projectKey: null, version: 1, locked: false, archived: false });
      expect(page.author.displayName).toBe('bob');
      expect(page.permissions).toMatchObject({ canEdit: false, canLock: false, canComment: true });
      expect((await (await call('bob', 'GET', `/rest/api/2/pages/${id}`)).json()).permissions.canEdit).toBe(true);
    });

    test('only the author and administrators edit it', async () => {
      expect((await call('alice', 'PUT', `/rest/api/2/pages/${id}`, { body: 'x' })).status).toBe(403);
      expect((await call('bob', 'PUT', `/rest/api/2/pages/${id}`, { body: 'by author' })).status).toBe(200);
      expect((await call('admin', 'PUT', `/rest/api/2/pages/${id}`, { body: 'by admin' })).status).toBe(200);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/archive`)).status).toBe(403);
    });

    test('validates input strictly', async () => {
      expect((await call('bob', 'POST', '/rest/api/2/pages', { title: '' })).status).toBe(400);
      expect((await call('bob', 'POST', '/rest/api/2/pages', { title: 'x', authorId: 1 })).status).toBe(400);
      expect((await call('bob', 'PUT', `/rest/api/2/pages/${id}`, { version: 9 })).status).toBe(400);
      expect((await call('bob', 'GET', '/rest/api/2/pages/abc')).status).toBe(404);
      expect((await call('bob', 'GET', '/rest/api/2/pages/999999')).status).toBe(404);
    });
  });

  describe('project pages and hidden data', () => {
    let secret: number;
    let shared: number;
    test('a project page is invisible (404) to users who cannot browse the project', async () => {
      secret = await create('admin', { title: 'Hidden roadmap', body: 'zebrafish plan', projectKey: 'TEST' });
      for (const who of ['alice', 'bob', 'carol']) {
        expect((await call(who, 'GET', `/rest/api/2/pages/${secret}`)).status, who).toBe(404);
        expect((await call(who, 'GET', `/rest/api/2/pages/${secret}/versions`)).status).toBe(404);
        expect((await call(who, 'GET', `/rest/api/2/pages/${secret}/comments`)).status).toBe(404);
        expect((await call(who, 'POST', `/rest/api/2/pages/${secret}/comments`, { body: 'hi' })).status).toBe(404);
        expect((await call(who, 'PUT', `/rest/api/2/pages/${secret}`, { title: 'x' })).status).toBe(404);
        expect((await call(who, 'POST', `/rest/api/2/pages/${secret}/archive`)).status).toBe(404);
        expect((await call(who, 'POST', `/rest/api/2/pages/${secret}/convert-to-issue`, { projectKey: 'OTHER', text: 'x' })).status).toBe(404);
        expect((await call(who, 'GET', '/rest/api/2/pages?project=TEST')).status).toBe(404);
        expect((await call(who, 'GET', '/rest/api/2/pages/search?q=zebrafish&project=TEST')).status).toBe(404);
        const all = await (await call(who, 'GET', '/rest/api/2/pages')).json();
        expect(JSON.stringify(all)).not.toContain('Hidden roadmap');
        const found = await (await call(who, 'GET', '/rest/api/2/pages/search?q=zebrafish')).json();
        expect(found.results).toEqual([]);
        // not even creating pages in a project you cannot see reveals it
        expect((await call(who, 'POST', '/rest/api/2/pages', { title: 'x', projectKey: 'TEST' })).status).toBe(404);
      }
      expect((await call('admin', 'GET', `/rest/api/2/pages/${secret}`)).status).toBe(200);
    });

    test('browse-only users read but cannot create, edit or comment; developers can', async () => {
      shared = await create('alice', { title: 'Design notes', body: 'quokka design', projectKey: 'OTHER' });
      const carolView = await call('carol', 'GET', `/rest/api/2/pages/${shared}`);
      expect(carolView.status).toBe(200);
      expect((await carolView.json()).permissions).toMatchObject({ canEdit: false, canComment: false });
      expect((await call('carol', 'POST', '/rest/api/2/pages', { title: 'x', projectKey: 'OTHER' })).status).toBe(403);
      expect((await call('carol', 'PUT', `/rest/api/2/pages/${shared}`, { body: 'x' })).status).toBe(403);
      expect((await call('carol', 'POST', `/rest/api/2/pages/${shared}/comments`, { body: 'x' })).status).toBe(403);
      expect((await call('bob', 'GET', `/rest/api/2/pages/${shared}`)).status).toBe(404);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${shared}`, { body: 'dave was here' })).status).toBe(200);
      expect((await call('dave', 'POST', `/rest/api/2/pages/${shared}/comments`, { body: 'nice' })).status).toBe(201);
    });

    test('lists respect scope', async () => {
      const list = (await (await call('alice', 'GET', '/rest/api/2/pages?project=OTHER')).json()).pages;
      expect(list.map((p: any) => p.title)).toEqual(['Design notes']);
      expect(list[0].projectKey).toBe('OTHER');
      const ws = (await (await call('alice', 'GET', '/rest/api/2/pages?workspace=true')).json()).pages;
      expect(ws.every((p: any) => p.projectKey === null)).toBe(true);
      const everything = (await (await call('alice', 'GET', '/rest/api/2/pages')).json()).pages.map((p: any) => p.title);
      expect(everything).toContain('Handbook');
      expect(everything).toContain('Design notes');
      expect(everything).not.toContain('Hidden roadmap');
    });
  });

  describe('locked pages', () => {
    let id: number;
    test('after locking only the author and administrators can edit', async () => {
      id = await create('alice', { title: 'Release process', body: 'v1', projectKey: 'OTHER' });
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { body: 'v1 edited by dave' })).status).toBe(200);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { locked: true })).status).toBe(403); // not the author
      expect((await call('alice', 'PUT', `/rest/api/2/pages/${id}`, { locked: true })).status).toBe(200);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { body: 'nope' })).status).toBe(403);
      expect((await call('dave', 'POST', `/rest/api/2/pages/${id}/move`, { parentId: null })).status).toBe(403);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { locked: false })).status).toBe(403);
      // reading and commenting stay open
      const view = await (await call('dave', 'GET', `/rest/api/2/pages/${id}`)).json();
      expect(view).toMatchObject({ locked: true, permissions: { canEdit: false, canComment: true } });
      expect((await call('dave', 'POST', `/rest/api/2/pages/${id}/comments`, { body: 'question' })).status).toBe(201);
      expect((await call('alice', 'PUT', `/rest/api/2/pages/${id}`, { body: 'author edit' })).status).toBe(200);
      expect((await call('admin', 'PUT', `/rest/api/2/pages/${id}`, { body: 'admin edit' })).status).toBe(200);
      expect((await call('admin', 'PUT', `/rest/api/2/pages/${id}`, { locked: false })).status).toBe(200);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { body: 'open again' })).status).toBe(200);
    });
  });

  describe('versions and restore', () => {
    let id: number;
    test('every change stores a version, identical saves do not', async () => {
      id = await create('alice', { title: 'Runbook', body: 'line1\nline2', projectKey: 'OTHER' });
      expect((await (await call('alice', 'PUT', `/rest/api/2/pages/${id}`, { body: 'line1\nline2\nline3' })).json()).version).toBe(2);
      const same = await (await call('alice', 'PUT', `/rest/api/2/pages/${id}`, { body: 'line1\nline2\nline3' })).json();
      expect(same).toMatchObject({ version: 2, changed: false });
      expect((await (await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { title: 'Runbook v2', body: 'line1\nCHANGED\nline3' })).json()).version).toBe(3);
      const list = await (await call('carol', 'GET', `/rest/api/2/pages/${id}/versions`)).json();
      expect(list.current).toBe(3);
      expect(list.versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
      expect(list.versions[0]).toMatchObject({ added: 1, removed: 1, title: 'Runbook v2' });
      expect(list.versions[0].author.displayName).toBe('dave');
      expect(list.versions[1]).toMatchObject({ added: 1, removed: 0 });
      expect(list.versions[0].body).toBeUndefined(); // bodies are fetched one at a time
    });

    test('view a version with its diff against the previous one and against the current page', async () => {
      const v2 = await (await call('carol', 'GET', `/rest/api/2/pages/${id}/versions/2`)).json();
      expect(v2).toMatchObject({ version: 2, body: 'line1\nline2\nline3', compared: 'v1', isCurrent: false, summary: { added: 1, removed: 0 } });
      const vs = await (await call('carol', 'GET', `/rest/api/2/pages/${id}/versions/2?compare=current`)).json();
      expect(vs.compared).toBe('current');
      expect(vs.titleChanged).toEqual({ from: 'Runbook v2', to: 'Runbook' });
      expect(vs.summary).toEqual({ added: 1, removed: 1 });
      expect((await call('carol', 'GET', `/rest/api/2/pages/${id}/versions/9`)).status).toBe(404);
    });

    test('restore creates a new version and needs edit rights', async () => {
      expect((await call('carol', 'POST', `/rest/api/2/pages/${id}/versions/1/restore`)).status).toBe(403);
      const res = await call('alice', 'POST', `/rest/api/2/pages/${id}/versions/1/restore`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ version: 4, changed: true });
      const page = await (await call('alice', 'GET', `/rest/api/2/pages/${id}`)).json();
      expect(page).toMatchObject({ body: 'line1\nline2', title: 'Runbook', version: 4 });
      const v4 = await (await call('alice', 'GET', `/rest/api/2/pages/${id}/versions/4`)).json();
      expect(v4.restoredFrom).toBe(1);
      // history is append-only: the old versions are all still there
      expect((await (await call('alice', 'GET', `/rest/api/2/pages/${id}/versions`)).json()).versions).toHaveLength(4);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/versions/4/restore`)).status).toBe(200); // already current: no-op
    });

    test('a stale expectedVersion is a conflict, not an overwrite', async () => {
      const res = await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { body: 'late', expectedVersion: 2 });
      expect(res.status).toBe(409);
      expect((await res.json()).currentVersion).toBe(4);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}`, { body: 'in time', expectedVersion: 4 })).status).toBe(200);
    });
  });

  describe('tree: nesting, ordering, archive', () => {
    let root: number; let a: number; let b: number; let c: number;
    test('children, ordering and moves', async () => {
      root = await create('alice', { title: 'Docs', projectKey: 'OTHER' });
      a = await create('alice', { title: 'A', parentId: root, projectKey: 'OTHER' });
      b = await create('alice', { title: 'B', parentId: root, projectKey: 'OTHER' });
      c = await create('alice', { title: 'C', parentId: a, projectKey: 'OTHER' });
      const pages = async () => (await (await call('alice', 'GET', '/rest/api/2/pages?project=OTHER')).json()).pages as any[];
      const kids = async (p: number) => (await pages()).filter((x) => x.parentId === p).sort((x, y) => x.position - y.position).map((x) => x.title);
      expect(await kids(root)).toEqual(['A', 'B']);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${b}/move`, { parentId: root, index: 0 })).status).toBe(200);
      expect(await kids(root)).toEqual(['B', 'A']);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${c}/move`, { parentId: root, index: 1 })).status).toBe(200);
      expect(await kids(root)).toEqual(['B', 'C', 'A']);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${c}/move`, { parentId: null })).status).toBe(200);
      expect(await kids(root)).toEqual(['B', 'A']);
      expect((await (await call('alice', 'GET', `/rest/api/2/pages/${c}`)).json()).ancestors).toEqual([]);
      expect((await (await call('alice', 'GET', `/rest/api/2/pages/${a}`)).json()).ancestors).toEqual([{ id: root, title: 'Docs' }]);
    });

    test('rejects cycles, other scopes and unknown parents', async () => {
      expect((await call('alice', 'POST', `/rest/api/2/pages/${root}/move`, { parentId: a })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${root}/move`, { parentId: root })).status).toBe(400);
      const ws = await create('alice', { title: 'Workspace page' });
      expect((await call('alice', 'POST', `/rest/api/2/pages/${a}/move`, { parentId: ws })).status).toBe(400);
      expect((await call('alice', 'POST', '/rest/api/2/pages', { title: 'x', parentId: ws, projectKey: 'OTHER' })).status).toBe(400);
      expect((await call('alice', 'POST', '/rest/api/2/pages', { title: 'x', parentId: 987654 })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${a}/move`, { parentId: 987654 })).status).toBe(400);
    });

    test('archiving hides the subtree and restoring brings it back', async () => {
      const res = await call('alice', 'POST', `/rest/api/2/pages/${root}/archive`);
      expect((await res.json()).count).toBe(3); // Docs, A, B (C was moved out)
      const live = (await (await call('alice', 'GET', '/rest/api/2/pages?project=OTHER')).json()).pages.map((p: any) => p.title);
      expect(live).not.toContain('Docs');
      expect(live).not.toContain('A');
      const arch = (await (await call('alice', 'GET', '/rest/api/2/pages?project=OTHER&archived=true')).json()).pages.map((p: any) => p.title);
      expect(arch.sort()).toEqual(['A', 'B', 'Docs']);
      // archived pages stay readable but read-only, and drop out of search
      const view = await (await call('alice', 'GET', `/rest/api/2/pages/${a}`)).json();
      expect(view).toMatchObject({ archived: true, permissions: { canEdit: false } });
      expect((await call('alice', 'PUT', `/rest/api/2/pages/${a}`, { body: 'x' })).status).toBe(409);
      expect((await call('dave', 'POST', `/rest/api/2/pages/${root}/unarchive`)).status).toBe(200);
      const back = (await (await call('alice', 'GET', '/rest/api/2/pages?project=OTHER')).json()).pages.map((p: any) => p.title);
      expect(back).toEqual(expect.arrayContaining(['Docs', 'A', 'B']));
    });
  });

  describe('comments', () => {
    let id: number;
    test('threads, quotes, editing and deleting', async () => {
      id = await create('alice', { title: 'Commented', body: 'text', projectKey: 'OTHER' });
      const top = (await (await call('dave', 'POST', `/rest/api/2/pages/${id}/comments`, { body: 'Question?', quote: 'text' })).json()).id;
      const reply = (await (await call('alice', 'POST', `/rest/api/2/pages/${id}/comments`, { body: 'Answer.', parentId: top })).json()).id;
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/comments`, { body: 'too deep', parentId: reply })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/comments`, { body: 'x', parentId: 99999 })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/comments`, { body: '  ' })).status).toBe(400);
      const list = (await (await call('carol', 'GET', `/rest/api/2/pages/${id}/comments`)).json()).comments;
      expect(list.map((x: any) => [x.body, x.parentId])).toEqual([['Question?', null], ['Answer.', top]]);
      expect(list[0].quote).toBe('text');
      expect(list[0]).toMatchObject({ canEdit: false, canDelete: false });
      expect((await call('alice', 'PUT', `/rest/api/2/pages/${id}/comments/${top}`, { body: 'hijack' })).status).toBe(403);
      expect((await call('dave', 'PUT', `/rest/api/2/pages/${id}/comments/${top}`, { body: 'Question (edited)?' })).status).toBe(200);
      expect((await call('carol', 'DELETE', `/rest/api/2/pages/${id}/comments/${top}`)).status).toBe(403);
      expect((await call('alice', 'DELETE', `/rest/api/2/pages/${id}/comments/${top}`)).status).toBe(403); // not the author, not an admin
      expect((await call('admin', 'DELETE', `/rest/api/2/pages/${id}/comments/${top}`)).status).toBe(200);
      expect((await (await call('alice', 'GET', `/rest/api/2/pages/${id}/comments`)).json()).comments).toEqual([]); // reply went with it
      // a comment id of another page is not reachable through this page
      const other = await create('alice', { title: 'Other', projectKey: 'OTHER' });
      const c2 = (await (await call('alice', 'POST', `/rest/api/2/pages/${other}/comments`, { body: 'x' })).json()).id;
      expect((await call('alice', 'DELETE', `/rest/api/2/pages/${id}/comments/${c2}`)).status).toBe(404);
    });
  });

  describe('search', () => {
    test('finds words and word prefixes in title and body with a snippet, and trims hidden pages', async () => {
      await create('alice', { title: 'Onboarding checklist', body: 'Order a laptop and request the Kubernetes access', projectKey: 'OTHER' });
      const hit = async (who: string, q: string) => (await (await call(who, 'GET', `/rest/api/2/pages/search?q=${encodeURIComponent(q)}`)).json()).results as any[];
      let r = await hit('carol', 'kubernetes');
      expect(r.map((x) => x.title)).toEqual(['Onboarding checklist']);
      expect(r[0].snippet).toContain('[[Kubernetes]]');
      expect(r[0].projectKey).toBe('OTHER');
      expect((await hit('carol', 'kube')).length).toBe(1); // prefix
      expect((await hit('carol', 'laptop access')).length).toBe(1); // all words
      expect((await hit('carol', 'laptop zzzunknown')).length).toBe(0);
      expect((await hit('carol', 'onboard')).length).toBe(1); // title
      expect((await hit('bob', 'kubernetes')).length).toBe(0); // bob cannot browse OTHER
      expect((await hit('admin', 'zebrafish')).map((x) => x.title)).toEqual(['Hidden roadmap']);
      expect((await hit('carol', "100%_'; DROP TABLE pages;--")).length).toBe(0);
      expect((await call('carol', 'GET', '/rest/api/2/pages/search?q=a')).status).toBe(400);
      r = await (await call('carol', 'GET', '/rest/api/2/pages/search?q=kubernetes&project=OTHER')).json().then((j: any) => j.results);
      expect(r.length).toBe(1);
    });
  });

  describe('convert highlighted text to an issue', () => {
    let id: number;
    test('creates the issue, links it from the page, and trims the link for people who cannot browse the project', async () => {
      id = await create('bob', { title: 'Ideas', body: '- [ ] Add dark mode\n- other' }); // workspace page
      const bad = await call('bob', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: 'Add dark mode' });
      expect(bad.status).toBe(404); // bob cannot even see the project
      expect((await call('carol', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: 'Add dark mode' })).status).toBe(403); // browse only
      const res = await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: '- [ ] Add dark mode\nfor the board' });
      expect(res.status).toBe(201);
      const { issue } = await res.json();
      expect(issue.key).toMatch(/^OTHER-\d+$/);
      const created = await (await call('alice', 'GET', `/rest/api/2/issue/${issue.key}`)).json();
      expect(created.fields?.summary ?? created.summary).toBe('Add dark mode');
      expect(JSON.stringify(created)).toContain(`/pages/${id}`);
      // linked issues show for people who can browse OTHER ...
      const asAlice = await (await call('alice', 'GET', `/rest/api/2/pages/${id}`)).json();
      expect(asAlice.linkedIssues).toHaveLength(1);
      expect(asAlice.linkedIssues[0]).toMatchObject({ issueKey: issue.key, summary: 'Add dark mode' });
      expect(asAlice.linkedIssues[0].quote).toContain('Add dark mode');
      // ... and are left out for those who cannot (bob can read the page, not the issue)
      expect((await (await call('bob', 'GET', `/rest/api/2/pages/${id}`)).json()).linkedIssues).toEqual([]);
    });

    test('custom summary, validation and unknown projects', async () => {
      const ok = await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: 'other', summary: 'Custom title' });
      expect(ok.status).toBe(201);
      expect((await (await call('alice', 'GET', `/rest/api/2/pages/${id}`)).json()).linkedIssues).toHaveLength(2);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: '' })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'OTHER', text: 'x', extra: 1 })).status).toBe(400);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'NOPE', text: 'x' })).status).toBe(404);
      expect((await call('alice', 'POST', `/rest/api/2/pages/${id}/convert-to-issue`, { projectKey: 'TEST', text: 'x' })).status).toBe(404); // alice cannot browse TEST
    });
  });

  describe('feature switch', () => {
    test('switching Pages off closes the API and on restores it with the data intact', async () => {
      const id = await create('alice', { title: 'Survives', projectKey: 'OTHER' });
      expect((await call('admin', 'PUT', '/rest/api/2/admin/features/pages', { enabled: false })).status).toBe(200);
      invalidateFeatures();
      expect((await call('alice', 'GET', '/rest/api/2/pages')).status).toBe(404);
      expect((await call('alice', 'GET', `/rest/api/2/pages/${id}`)).status).toBe(404);
      expect((await call('alice', 'GET', '/rest/api/2/pages/search?q=surv')).status).toBe(404);
      expect((await call('admin', 'PUT', '/rest/api/2/admin/features/pages', { enabled: true })).status).toBe(200);
      invalidateFeatures();
      expect((await call('alice', 'GET', `/rest/api/2/pages/${id}`)).status).toBe(200);
    });
  });
});
