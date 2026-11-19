import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

describe('Labels API (colours, management, remove on resolution)', () => {
  let seeded: any;
  let admin: string;
  let editor: string;
  let manager: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let doneStatusId: number;
  let resolutionId: number;
  let resolveTransitionId: number;

  const json = (cookie: string) => ({ 'Content-Type': 'application/json', Cookie: cookie });

  async function login(username: string) {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  }

  async function createIssue(summary: string, labels?: string[], cookie = admin) {
    const res = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: json(cookie),
      body: JSON.stringify({
        fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary, ...(labels ? { labels } : {}) },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; key: string };
  }

  async function getIssue(key: string) {
    const res = await app.request(`/rest/api/2/issue/${key}`, { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }

  async function labelByName(name: string) {
    const res = await app.request('/rest/api/2/label', { headers: { Cookie: admin } });
    const body = (await res.json()) as any;
    return body.labels.find((l: any) => l.name === name);
  }

  beforeAll(async () => {
    // Earlier suites reuse the same issue keys (TEST-1...) and user ids: drop their cached responses.
    for (const pattern of ['veqsio:ratelimit:*', 'veqsio:cache:*', 'veqsio:issue:*']) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(...keys);
    }
    testSql = createTestSql();
    await testSql`SELECT 1`;
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [ed, mgr] = await db
      .insert(schema.users)
      .values([
        { username: 'edie', email: 'edie@example.com', displayName: 'Edie Editor', passwordHash: hash },
        { username: 'manu', email: 'manu@example.com', displayName: 'Manu Manager', passwordHash: hash },
      ])
      .returning();
    const entries = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'TRANSITION_ISSUES'].flatMap((permissionKey) => [
      { schemeId: seeded.permScheme.id, permissionKey, userId: ed.id },
      { schemeId: seeded.permScheme.id, permissionKey, userId: mgr.id },
    ]);
    entries.push({ schemeId: seeded.permScheme.id, permissionKey: 'PROJECT_ADMIN', userId: mgr.id });
    await db.insert(schema.permissionEntries).values(entries);

    admin = await login('admin');
    editor = await login('edie');
    manager = await login('manu');

    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#16A06A' }).returning();
    doneStatusId = done.id;
    const [res] = await db.insert(schema.resolutions).values({ name: 'Fixed' }).returning();
    resolutionId = res.id;
    const [resolve] = await db
      .insert(schema.workflowTransitions)
      .values({
        workflowId: seeded.workflow.id,
        name: 'Resolve',
        fromStatusId: seeded.status.id,
        toStatusId: doneStatusId,
        conditions: [{ type: 'always_true' }],
        validators: [],
        postFunctions: [],
      })
      .returning();
    resolveTransitionId = resolve.id;
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('Jira-style label strings still work and expose additive colour data', async () => {
    const issue = await createIssue('Plain strings', ['backend', 'urgent']);
    const body = await getIssue(issue.key);
    expect(body.fields.labels.sort()).toEqual(['backend', 'urgent']);
    expect(body.fields.labelDetails.map((l: any) => l.name).sort()).toEqual(['backend', 'urgent']);
    expect(body.fields.labelDetails[0]).toHaveProperty('color', null);
    expect(body.fields.labelDetails[0]).toHaveProperty('removeOnResolve', false);

    const put = await app.request(`/rest/api/2/issue/${issue.key}`, {
      method: 'PUT',
      headers: json(admin),
      body: JSON.stringify({ fields: { labels: ['backend', 'frontend', 'urgent'] } }),
    });
    expect(put.status).toBe(200);
    expect((await getIssue(issue.key)).fields.labels.sort()).toEqual(['backend', 'frontend', 'urgent']);
  });

  test('list returns Jira-compatible values plus colour, flag and usage counts', async () => {
    const res = await app.request('/rest/api/2/label', { headers: { Cookie: editor } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.values).toContain('backend');
    const backend = body.labels.find((l: any) => l.name === 'backend');
    expect(backend.issueCount).toBe(1);
    expect(backend.removeOnResolve).toBe(false);
    expect(body.palette.length).toBe(12);
    const filtered = (await (await app.request('/rest/api/2/label?query=front', { headers: { Cookie: editor } })).json()) as any;
    expect(filtered.values).toEqual(['frontend']);
  });

  test('unauthenticated requests are rejected', async () => {
    expect((await app.request('/rest/api/2/label')).status).toBe(401);
  });

  test('an editor can attach and create-on-type labels but cannot manage them', async () => {
    const issue = await createIssue('Editor attaches', undefined, editor);
    const put = await app.request(`/rest/api/2/issue/${issue.key}`, {
      method: 'PUT',
      headers: json(editor),
      body: JSON.stringify({ fields: { labels: ['backend', 'brand-new'] } }),
    });
    expect(put.status).toBe(200);
    expect((await getIssue(issue.key)).fields.labels.sort()).toEqual(['backend', 'brand-new']);

    const label = await labelByName('backend');
    const patch = await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(editor), body: JSON.stringify({ color: 'red' }) });
    expect(patch.status).toBe(403);
    const del = await app.request(`/rest/api/2/label/${label.id}`, { method: 'DELETE', headers: { Cookie: editor } });
    expect(del.status).toBe(403);
    const merge = await app.request(`/rest/api/2/label/${label.id}/merge`, { method: 'POST', headers: json(editor), body: JSON.stringify({ targetId: label.id + 1 }) });
    expect(merge.status).toBe(403);
    const create = await app.request('/rest/api/2/label', { method: 'POST', headers: json(editor), body: JSON.stringify({ name: 'nope' }) });
    expect(create.status).toBe(403);
  });

  test('a project administrator can update colour and the remove-on-resolution flag', async () => {
    const label = await labelByName('urgent');
    const res = await app.request(`/rest/api/2/label/${label.id}`, {
      method: 'PUT',
      headers: json(manager),
      body: JSON.stringify({ color: 'red', removeOnResolve: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.color).toBe('red');
    expect(body.removeOnResolve).toBe(true);
    expect(body.issueCount).toBe(1);

    const hex = await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ color: '#AB12CD' }) });
    expect(((await hex.json()) as any).color).toBe('#ab12cd');
    const reset = await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ color: null }) });
    expect(((await reset.json()) as any).color).toBeNull();
    await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ color: 'red' }) });
  });

  test('colour validation rejects unknown tokens, bad hex and css injection', async () => {
    const label = await labelByName('urgent');
    for (const color of ['chartreuse', '#12345', 'red;background:url(x)', 42]) {
      const res = await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ color }) });
      expect(res.status).toBe(400);
    }
    const flag = await app.request(`/rest/api/2/label/${label.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ removeOnResolve: 'yes' }) });
    expect(flag.status).toBe(400);
    expect((await labelByName('urgent')).color).toBe('red');
  });

  test('colour shows up on issue JSON as labelDetails while labels stays strings', async () => {
    const issue = await createIssue('Coloured', ['urgent']);
    const body = await getIssue(issue.key);
    expect(body.fields.labels).toEqual(['urgent']);
    expect(body.fields.labelDetails).toEqual([{ name: 'urgent', color: 'red', removeOnResolve: true }]);
    const search = await app.request(`/rest/api/2/search?jql=${encodeURIComponent('labels = urgent')}`, { headers: { Cookie: admin } });
    expect(search.status).toBe(200);
    const hit = ((await search.json()) as any).issues.find((i: any) => i.key === issue.key);
    expect(hit.fields.labelDetails[0].color).toBe('red');
  });

  test('rename conflict returns 409 and a successful rename keeps issue links', async () => {
    const urgent = await labelByName('urgent');
    const clash = await app.request(`/rest/api/2/label/${urgent.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ name: 'backend' }) });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as any).conflictId).toBeDefined();
    const bad = await app.request(`/rest/api/2/label/${urgent.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ name: 'a,b' }) });
    expect(bad.status).toBe(400);

    const ok = await app.request(`/rest/api/2/label/${urgent.id}`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ name: 'critical' }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).issueCount).toBe(2);
    const missing = await app.request('/rest/api/2/label/99999', { method: 'PUT', headers: json(admin), body: JSON.stringify({ name: 'zzz' }) });
    expect(missing.status).toBe(404);
  });

  test('merge moves issues, avoids duplicates, records history and deletes the source', async () => {
    const a = await createIssue('Has both', ['dup-a', 'dup-b']);
    const b = await createIssue('Has source only', ['dup-a']);
    const src = await labelByName('dup-a');
    const tgt = await labelByName('dup-b');

    const self = await app.request(`/rest/api/2/label/${src.id}/merge`, { method: 'POST', headers: json(admin), body: JSON.stringify({ targetId: src.id }) });
    expect(self.status).toBe(400);

    const res = await app.request(`/rest/api/2/label/${src.id}/merge`, { method: 'POST', headers: json(admin), body: JSON.stringify({ targetId: tgt.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.moved).toBe(1);
    expect(body.duplicates).toBe(1);
    expect(body.merged.issueCount).toBe(2);
    expect(await labelByName('dup-a')).toBeUndefined();
    expect((await getIssue(a.key)).fields.labels).toEqual(['dup-b']);
    expect((await getIssue(b.key)).fields.labels).toEqual(['dup-b']);
    const hist = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, b.id), eq(schema.issueHistory.fieldName, 'labels')));
    expect(hist.some((h) => h.oldValue === 'dup-a' && h.newValue === 'dup-b')).toBe(true);
  });

  test('delete refuses used labels, removes unused ones and supports bulk cleanup', async () => {
    const used = await labelByName('dup-b');
    const refused = await app.request(`/rest/api/2/label/${used.id}`, { method: 'DELETE', headers: { Cookie: admin } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).issueCount).toBe(2);

    const created = await app.request('/rest/api/2/label', { method: 'POST', headers: json(manager), body: JSON.stringify({ name: 'temp-1', color: 'teal' }) });
    expect(created.status).toBe(201);
    const dupe = await app.request('/rest/api/2/label', { method: 'POST', headers: json(manager), body: JSON.stringify({ name: 'temp-1' }) });
    expect(dupe.status).toBe(409);
    const id = ((await created.json()) as any).id;
    expect((await app.request(`/rest/api/2/label/${id}`, { method: 'DELETE', headers: { Cookie: manager } })).status).toBe(204);
    expect((await app.request(`/rest/api/2/label/${id}`, { method: 'DELETE', headers: { Cookie: manager } })).status).toBe(404);

    await app.request('/rest/api/2/label', { method: 'POST', headers: json(admin), body: JSON.stringify({ name: 'temp-2' }) });
    await app.request('/rest/api/2/label', { method: 'POST', headers: json(admin), body: JSON.stringify({ name: 'temp-3' }) });
    expect((await app.request('/rest/api/2/label', { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(400);
    const bulk = await app.request('/rest/api/2/label?unused=true', { method: 'DELETE', headers: { Cookie: admin } });
    expect(bulk.status).toBe(200);
    expect(((await bulk.json()) as any).deleted).toBe(2);
    expect(await labelByName('dup-b')).toBeDefined();
  });

  test('resolving through a transition removes flagged labels and writes history', async () => {
    const flagged = await labelByName('critical');
    expect(flagged.removeOnResolve).toBe(true);
    const issue = await createIssue('Resolve via transition', ['critical', 'keep-me']);
    const res = await app.request(`/rest/api/2/issue/${issue.key}/transitions`, {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify({ transition: { id: resolveTransitionId }, fields: { resolution: { id: resolutionId } } }),
    });
    expect(res.status).toBe(200);
    const body = await getIssue(issue.key);
    expect(body.fields.labels).toEqual(['keep-me']);
    expect(body.fields.status.name).toBe('Done');
    const hist = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issue.id), eq(schema.issueHistory.fieldName, 'labels')));
    expect(hist).toHaveLength(1);
    expect(hist[0].oldValue).toBe('critical,keep-me');
    expect(hist[0].newValue).toBe('keep-me');
  });

  test('setting a resolution through a field update also removes flagged labels', async () => {
    const issue = await createIssue('Resolve via PUT', ['critical']);
    const res = await app.request(`/rest/api/2/issue/${issue.key}`, {
      method: 'PUT',
      headers: json(admin),
      body: JSON.stringify({ fields: { resolution: { id: resolutionId } } }),
    });
    expect(res.status).toBe(200);
    expect((await getIssue(issue.key)).fields.labels).toEqual([]);
  });

  test('issues that are not resolved keep flagged labels', async () => {
    const issue = await createIssue('Still open', ['critical']);
    const put = await app.request(`/rest/api/2/issue/${issue.key}`, {
      method: 'PUT',
      headers: json(admin),
      body: JSON.stringify({ fields: { summary: 'Still open, renamed' } }),
    });
    expect(put.status).toBe(200);
    expect((await getIssue(issue.key)).fields.labels).toEqual(['critical']);
  });
});
