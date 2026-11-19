import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { hmacHex } from '../../src/scm/parse';
import { setScmFetch } from '../../src/scm/providers';

describe('Git integrations', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let repo: { id: number; webhookSecret: string; webhookUrl: string };
  let issueKey: string;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const hook = (payload: unknown, event: string, secret = repo.webhookSecret) => {
    const raw = JSON.stringify(payload);
    return app.request(`/rest/webhooks/scm/${repo.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${hmacHex(secret, raw)}` }, body: raw });
  };

  beforeAll(async () => {
    process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'true';
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    issueKey = (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Fix the login page', priority: { id: seeded.priority.id } } })).json()).key;
  });
  afterAll(async () => { setScmFetch(null); await resetTestDb(testSql); await testSql.end(); });

  test('links a repository and returns the secret once', async () => {
    const res = await call('POST', '/rest/api/2/project/TEST/repositories', { provider: 'github', name: 'acme/app', accessToken: 'tok' });
    expect(res.status).toBe(201);
    repo = await res.json();
    expect(repo.webhookSecret.length).toBeGreaterThan(20);
    expect(repo.webhookUrl).toContain(`/rest/webhooks/scm/${repo.id}`);
    const list = await (await call('GET', '/rest/api/2/project/TEST/repositories')).json();
    expect(list[0].webhookSecret).toBeUndefined();
    expect(list[0].hasToken).toBe(true);
    expect((await call('POST', '/rest/api/2/project/TEST/repositories', { provider: 'github', name: 'acme/app' })).status).toBe(409);
    expect((await call('POST', '/rest/api/2/project/TEST/repositories', { provider: 'gitea', name: 'a/b' })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/project/TEST/repositories', { provider: 'github', name: 'bad name' })).status).toBe(400);
  });

  test('rejects unsigned and wrongly signed webhooks', async () => {
    expect((await app.request(`/rest/webhooks/scm/${repo.id}`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await hook({}, 'push', 'wrong')).status).toBe(401);
    expect((await app.request('/rest/webhooks/scm/99999', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  test('a push links the branch and commits to the issue and a PR adds status', async () => {
    const lower = issueKey.toLowerCase();
    const res = await hook({ ref: `refs/heads/${lower}-login`, repository: { html_url: 'https://github.com/acme/app' }, commits: [{ id: 'abc123', message: `${issueKey} fix it`, url: 'https://github.com/acme/app/commit/abc123', author: { name: 'Dev', email: 'dev@example.com' } }] }, 'push');
    expect(res.status).toBe(200);
    expect((await res.json()).linked).toBe(2);
    // retry is idempotent
    expect((await (await hook({ ref: `refs/heads/${lower}-login`, commits: [{ id: 'abc123', message: `${issueKey} fix it` }] }, 'push')).json()).linked).toBe(0);
    await hook({ pull_request: { number: 5, title: `${issueKey} login`, html_url: 'https://github.com/acme/app/pull/5', state: 'open', merged: false, head: { ref: `${lower}-login` } } }, 'pull_request');
    await hook({ workflow_run: { head_branch: `${lower}-login`, status: 'completed', conclusion: 'success', html_url: 'u' } }, 'workflow_run');
    const dev = await (await call('GET', `/rest/api/2/issue/${issueKey}/development`)).json();
    expect(dev.branches.length).toBe(1);
    expect(dev.commits[0].ref).toBe('abc123');
    expect(dev.pullRequests[0]).toMatchObject({ ref: '5', status: 'open', buildStatus: 'success' });
    await hook({ pull_request: { number: 5, title: `${issueKey} login`, html_url: 'u', state: 'closed', merged: true, head: { ref: `${lower}-login` } } }, 'pull_request');
    expect((await (await call('GET', `/rest/api/2/issue/${issueKey}/development`)).json()).pullRequests[0].status).toBe('merged');
  });

  test('smart commits comment as a matching user and ignore unknown authors', async () => {
    const email = seeded.user.email;
    await hook({ ref: 'refs/heads/main', commits: [{ id: 'def456', message: `${issueKey} #comment from git`, author: { name: 'A', email } }, { id: 'ghi789', message: `${issueKey} #comment stranger`, author: { name: 'X', email: 'nobody@example.com' } }] }, 'push');
    const comments = (await (await call('GET', `/rest/api/2/issue/${issueKey}/comment`)).json()).comments.map((x: any) => x.body);
    expect(comments).toContain('from git');
    expect(comments).not.toContain('stranger');
  });

  test('creates a branch through the provider API', async () => {
    const seen: string[] = [];
    setScmFetch(async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ object: { sha: 'deadbeef' } }), { status: 200 });
    });
    const res = await call('POST', `/rest/api/2/issue/${issueKey}/development/branch`, { repositoryId: repo.id });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.branch).toBe(`${issueKey}-fix-the-login-page`);
    expect(seen[1]).toContain('POST https://api.github.com/repos/acme/app/git/refs');
    expect((await call('POST', `/rest/api/2/issue/${issueKey}/development/branch`, { repositoryId: repo.id, name: 'bad..name' })).status).toBe(400);
    setScmFetch(async () => new Response('nope', { status: 401 }));
    expect((await call('POST', `/rest/api/2/issue/${issueKey}/development/branch`, { repositoryId: repo.id, name: 'other' })).status).toBe(502);
  });

  test('release notes group issues by type', async () => {
    const v = await (await call('POST', '/rest/api/2/project/TEST/versions', { name: '1.0' })).json();
    await call('PUT', `/rest/api/2/issue/${issueKey}`, { fields: { fixVersions: [{ id: v.id }] } });
    const md = await (await call('GET', `/rest/api/2/project/TEST/versions/${v.id}/release-notes`)).text();
    expect(md).toContain('# ');
    expect(md).toContain(`- ${issueKey} Fix the login page`);
    expect((await call('GET', '/rest/api/2/project/TEST/versions/999999/release-notes')).status).toBe(404);
  });

  test('deleting the repository removes its links', async () => {
    expect((await call('DELETE', `/rest/api/2/project/TEST/repositories/${repo.id}`)).status).toBe(200);
    expect((await (await call('GET', `/rest/api/2/issue/${issueKey}/development`)).json()).commits.length).toBe(0);
  });
});
