import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateInstanceSettings } from '../../src/settings/instance';

describe('Public projects', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let key: string;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const anon = (path: string) => app.request(path);
  const clean = async () => { await testSql`DELETE FROM system_settings WHERE key LIKE 'instance.%'`; invalidateInstanceSettings(); };

  beforeAll(async () => {
    testSql = createTestSql();
    await clean();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    key = (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Public bug', description: 'Visible **text**', priority: { id: seeded.priority.id } } })).json()).key;
    await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'public remark' });
    await call('POST', `/rest/api/2/issue/${key}/comment`, { body: 'secret internal note', internal: true });
    await testSql`UPDATE comments SET is_internal = true WHERE body = 'secret internal note'`;
  });
  afterAll(async () => { await clean(); await resetTestDb(testSql); await testSql.end(); });

  test('nothing is public by default', async () => {
    expect((await anon('/rest/public/projects')).status).toBe(404);
    expect((await anon(`/rest/public/issues/${key}`)).status).toBe(404);
    expect((await (await anon('/rest/public/config')).json()).enabled).toBe(false);
    const res = await call('PUT', '/rest/api/2/project/TEST', { isPublic: true });
    expect(res.status).toBe(400); // instance setting still off
  });

  test('a public project is readable anonymously, without private data', async () => {
    await call('PUT', '/rest/api/2/admin/settings', { publicProjectsEnabled: true });
    invalidateInstanceSettings();
    expect((await call('PUT', '/rest/api/2/project/TEST', { isPublic: true })).status).toBe(200);
    expect((await call('PUT', '/rest/api/2/project/TEST', { isPublic: 'yes' })).status).toBe(400);

    const list = await (await anon('/rest/public/projects')).json();
    expect(list.projects.map((p: any) => p.key)).toContain('TEST');
    const issues = await (await anon('/rest/public/projects/test/issues?q=bug')).json();
    expect(issues.issues[0].key).toBe(key);

    const res = await anon(`/rest/public/issues/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public');
    const raw = await res.text();
    const issue = JSON.parse(raw);
    expect(issue.comments.map((c: any) => c.body)).toEqual(['public remark']);
    expect(raw).not.toContain('secret internal note');
    expect(raw).not.toContain(seeded.user.email); // no email addresses
    expect(issue.reporter).toBe(seeded.user.displayName);
    const sm = await (await anon('/rest/public/sitemap')).json();
    expect(sm.projects[0].key).toBe('TEST');
    expect(sm.issues.map((i: any) => i.key)).toContain(key);
  });

  test('private projects, service desk projects and unknown keys stay hidden', async () => {
    expect((await anon('/rest/public/projects/NOPE')).status).toBe(404);
    expect((await anon('/rest/public/issues/NOPE-1')).status).toBe(404);
    await testSql`UPDATE projects SET is_public = false WHERE project_key = 'TEST'`;
    expect((await anon(`/rest/public/issues/${key}`)).status).toBe(404);
    expect((await anon('/rest/public/projects/TEST')).status).toBe(404);
    // a project that became a service desk disappears even when flagged public
    await testSql`UPDATE projects SET is_public = true WHERE project_key = 'TEST'`;
    await testSql`INSERT INTO service_desks (project_id, name, slug) SELECT id, 'Desk', 'desk-x' FROM projects WHERE project_key = 'TEST'`;
    expect((await anon(`/rest/public/issues/${key}`)).status).toBe(404);
    await testSql`DELETE FROM service_desks WHERE slug = 'desk-x'`;
  });

  test('a project can opt out of indexing: flagged on its pages, left out of the sitemap, stays readable', async () => {
    await call('PUT', '/rest/api/2/admin/settings', { publicProjectsEnabled: true });
    invalidateInstanceSettings();
    expect((await call('PUT', '/rest/api/2/project/TEST', { isPublic: true })).status).toBe(200);
    expect((await call('PUT', '/rest/api/2/project/TEST', { publicIndexing: 'sometimes' })).status).toBe(400);
    expect((await (await anon('/rest/public/projects/test')).json()).indexable).toBe(true);
    expect((await (await anon('/rest/public/sitemap')).json()).projects.map((p: any) => p.key)).toContain('TEST');

    const put = await (await call('PUT', '/rest/api/2/project/TEST', { publicIndexing: 'none' })).json();
    expect(put.publicIndexing).toBe('none');
    expect((await (await call('GET', '/rest/api/2/project/TEST')).json()).publicIndexing).toBe('none');
    expect((await (await anon('/rest/public/projects/test')).json()).indexable).toBe(false);
    expect((await (await anon(`/rest/public/issues/${key}`)).json()).indexable).toBe(false);
    const sm = await (await anon('/rest/public/sitemap')).json();
    expect(sm.projects.map((p: any) => p.key)).not.toContain('TEST');
    expect(sm.issues.map((i: any) => i.key)).not.toContain(key);
    // still readable
    expect((await anon(`/rest/public/issues/${key}`)).status).toBe(200);

    await call('PUT', '/rest/api/2/project/TEST', { publicIndexing: 'inherit' });
    expect((await (await anon('/rest/public/projects/test')).json()).indexable).toBe(true);
    // the instance policy still wins
    await call('PUT', '/rest/api/2/admin/settings', { publicIndexing: 'none' });
    invalidateInstanceSettings();
    expect((await (await anon('/rest/public/projects/test')).json()).indexable).toBe(false);
    await call('PUT', '/rest/api/2/admin/settings', { publicIndexing: 'all' });
    invalidateInstanceSettings();
  });

  test('public board and roadmap are off until the project turns them on, then read-only and without personal data', async () => {
    await call('PUT', '/rest/api/2/admin/settings', { publicProjectsEnabled: true });
    invalidateInstanceSettings();
    expect((await call('PUT', '/rest/api/2/project/TEST', { isPublic: true })).status).toBe(200);
    expect((await anon('/rest/public/projects/test/board')).status).toBe(404);
    expect((await anon('/rest/public/projects/test/roadmap')).status).toBe(404);
    expect((await call('PUT', '/rest/api/2/project/TEST', { publicBoard: 'yes' })).status).toBe(400);

    // a board with a column for the status of the public issue, and a version with that issue in it
    const [board] = await testSql`INSERT INTO boards (name, type, project_id) VALUES ('Public board', 'kanban', ${seeded.project.id}) RETURNING id`;
    const [st] = await testSql`SELECT status_id FROM issues WHERE issue_key = ${key}`;
    await testSql`INSERT INTO board_columns (board_id, status_id, name, sort_order) VALUES (${board.id}, ${st.status_id}, 'In the open', 0)`;
    const [ver] = await testSql`INSERT INTO versions (project_id, name, description, release_date, released) VALUES (${seeded.project.id}, 'v1.0', 'First release', '2027-01-01', false) RETURNING id`;
    await testSql`INSERT INTO versions (project_id, name, archived) VALUES (${seeded.project.id}, 'v0.1-old', true)`;
    await testSql`INSERT INTO issue_fix_versions (issue_id, version_id) SELECT id, ${ver.id} FROM issues WHERE issue_key = ${key}`;

    expect((await call('PUT', '/rest/api/2/project/TEST', { publicBoard: true, publicRoadmap: true })).status).toBe(200);
    const b = await (await anon('/rest/public/projects/test/board')).json();
    expect(b.columns[0].name).toBe('In the open');
    expect(b.columns[0].issues.map((i: any) => i.key)).toContain(key);
    expect(JSON.stringify(b)).not.toContain('@');
    const r = await (await anon('/rest/public/projects/test/roadmap')).json();
    expect(r.versions.map((v: any) => v.name)).toEqual(['v1.0']);
    expect(r.versions[0]).toMatchObject({ released: false, issues: { total: 1, done: 0 } });
    expect((await (await anon('/rest/public/projects/test')).json())).toMatchObject({ board: true, roadmap: true });

    // switching them off closes both again
    await call('PUT', '/rest/api/2/project/TEST', { publicBoard: false, publicRoadmap: false });
    expect((await anon('/rest/public/projects/test/board')).status).toBe(404);
    expect((await anon('/rest/public/projects/test/roadmap')).status).toBe(404);
  });

  test('turning the instance switch off closes everything again', async () => {
    await call('PUT', '/rest/api/2/admin/settings', { publicProjectsEnabled: false });
    invalidateInstanceSettings();
    expect((await anon(`/rest/public/issues/${key}`)).status).toBe(404);
    expect((await anon('/rest/public/sitemap')).status).toBe(404);
  });
});
