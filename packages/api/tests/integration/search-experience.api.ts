import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { runFilterDigests } from '../../src/services/filter-digest';
import { redis } from '../../src/services/cache';

describe('Search experience: filter sharing, JQL autocomplete, subscriptions', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin: string, carol: string, dave: string, erin: string;
  let ids: Record<string, number> = {};
  let hiddenProjectId: number;
  let groupId: number;

  // The in-memory rate limiter is shared by every integration file in the process and keyed by user id
  // (ids repeat across files); this file issues many requests, so reset it regularly.
  let calls = 0;
  const resetLimits = async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) await redis.del(`veqsio:ratelimit:user:${id}`);
    await redis.del('veqsio:ratelimit:ip:unknown');
  };
  const call = async (cookie: string, method: string, url: string, body?: unknown) => {
    if (calls++ % 25 === 0) await resetLimits();
    return app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  const login = async (username: string) => {
    await resetLimits();
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  const mkFilter = async (cookie: string, body: any = {}) => {
    const res = await call(cookie, 'POST', '/rest/api/2/filter', { name: 'f', jql: 'status = "To Do"', ...body });
    if (res.status !== 201) throw new Error(`mkFilter ${res.status}: ${await res.text()}`);
    return (await res.json()).id as string;
  };

  const mkIssue = async (projectId: number, key: string, summary: string) =>
    db.insert(schema.issues).values({
      issueKey: key, projectId, issueTypeId: seeded.issueType.id, statusId: seeded.status.id,
      summary, reporterId: seeded.user.id,
    }).returning();

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const created = await db.insert(schema.users).values(['carol', 'dave', 'erin'].map((n) => ({
      username: n, email: `${n}@example.com`, displayName: n, passwordHash: hash,
    }))).returning();
    for (const u of created) ids[u.username] = u.id;
    admin = await login('admin'); carol = await login('carol'); dave = await login('dave'); erin = await login('erin');

    // dave may browse TEST; carol and erin may not.
    await db.insert(schema.permissionEntries).values({
      schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: ids.dave,
    });
    // A second project nobody except admin can browse.
    const [hidden] = await db.insert(schema.projects).values({ projectKey: 'SECRET', name: 'Secret Project', leadId: seeded.user.id }).returning();
    hiddenProjectId = hidden.id;
    const [scheme2] = await db.insert(schema.permissionSchemes).values({ name: 'Locked' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: hidden.id, schemeId: scheme2.id });
    const [g] = await db.insert(schema.groups).values({ name: 'devs' }).returning();
    groupId = g.id;
    await db.insert(schema.userGroups).values([{ userId: ids.erin, groupId }, { userId: ids.carol, groupId }]);

    await mkIssue(seeded.project.id, 'TEST-1', 'Visible issue <script>alert(1)</script>');
    await mkIssue(hiddenProjectId, 'SECRET-1', 'Hidden issue');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ---------------- filter visibility ---------------- */

  test('private filters are invisible to other users (read, update, delete, share, list)', async () => {
    const id = await mkFilter(carol, { name: 'carol private' });
    for (const [method, url, body] of [
      ['GET', `/rest/api/2/filter/${id}`, undefined],
      ['PUT', `/rest/api/2/filter/${id}`, { name: 'hacked' }],
      ['DELETE', `/rest/api/2/filter/${id}`, undefined],
      ['PUT', `/rest/api/2/filter/${id}/share`, { shares: [{ type: 'global' }] }],
      ['GET', `/rest/api/2/filter/${id}/subscription`, undefined],
    ] as const) {
      const res = await call(dave, method, url, body);
      expect([method, url, res.status]).toEqual([method, url, 404]);
    }
    const list = await (await call(dave, 'GET', '/rest/api/2/filter')).json();
    expect(list.find((f: any) => f.id === id)).toBeUndefined();
    // owner and admin can see it
    expect((await call(carol, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(200);
    expect((await call(admin, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(200);
    // untouched
    const f = await (await call(carol, 'GET', `/rest/api/2/filter/${id}`)).json();
    expect(f.name).toBe('carol private');
  });

  test('?all=true is admin-only and lists everything', async () => {
    const id = await mkFilter(carol, { name: 'carol all-test' });
    expect((await call(dave, 'GET', '/rest/api/2/filter?all=true')).status).toBe(403);
    const adminList = await (await call(admin, 'GET', '/rest/api/2/filter?all=true')).json();
    expect(adminList.some((f: any) => f.id === id)).toBe(true);
  });

  test('user share: recipient reads but cannot edit, delete or re-share', async () => {
    const id = await mkFilter(carol, { name: 'for dave' });
    expect((await call(carol, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [{ type: 'user', id: ids.dave }] })).status).toBe(200);
    const res = await call(dave, 'GET', `/rest/api/2/filter/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.editable).toBe(false);
    expect(body.shares).toBeUndefined();
    expect((await call(dave, 'PUT', `/rest/api/2/filter/${id}`, { name: 'x' })).status).toBe(403);
    expect((await call(dave, 'DELETE', `/rest/api/2/filter/${id}`)).status).toBe(403);
    expect((await call(dave, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [{ type: 'global' }] })).status).toBe(403);
    expect((await call(erin, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(404);
    const list = await (await call(dave, 'GET', '/rest/api/2/filter')).json();
    expect(list.some((f: any) => f.id === id)).toBe(true);
    // unsharing removes access again
    await call(carol, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [] });
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(404);
  });

  test('group, project and global shares', async () => {
    const gid = await mkFilter(carol, { name: 'group', shares: [{ type: 'group', id: groupId }] });
    expect((await call(erin, 'GET', `/rest/api/2/filter/${gid}`)).status).toBe(200);
    expect((await call(dave, 'GET', `/rest/api/2/filter/${gid}`)).status).toBe(404);

    const pid = await mkFilter(dave, { name: 'project', shares: [{ type: 'project', id: seeded.project.id }] });
    expect((await call(dave, 'GET', `/rest/api/2/filter/${pid}`)).status).toBe(200);
    expect((await call(erin, 'GET', `/rest/api/2/filter/${pid}`)).status).toBe(404); // erin cannot browse TEST
    await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: ids.erin });
    expect((await call(erin, 'GET', `/rest/api/2/filter/${pid}`)).status).toBe(200);
    await db.delete(schema.permissionEntries).where(eq(schema.permissionEntries.userId, ids.erin));
    expect((await call(erin, 'GET', `/rest/api/2/filter/${pid}`)).status).toBe(404);

    const glob = await mkFilter(carol, { name: 'global', shares: [{ type: 'global' }] });
    expect((await call(dave, 'GET', `/rest/api/2/filter/${glob}`)).status).toBe(200);
    expect((await call(erin, 'GET', `/rest/api/2/filter/${glob}`)).status).toBe(200);
  });

  test('cannot share into groups you are not in, or projects you cannot browse, or missing targets', async () => {
    const id = await mkFilter(dave);
    const bad = async (shares: any[]) => (await call(dave, 'PUT', `/rest/api/2/filter/${id}/share`, { shares })).status;
    expect(await bad([{ type: 'group', id: groupId }])).toBe(400); // dave is not in devs
    expect(await bad([{ type: 'project', id: hiddenProjectId }])).toBe(400);
    expect(await bad([{ type: 'user', id: 999999 }])).toBe(400);
    expect(await bad([{ type: 'group', id: 999999 }])).toBe(400);
    expect((await call(admin, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [{ type: 'group', id: groupId }] })).status).toBe(200);
  });

  test('strict validation of bodies and shares', async () => {
    const id = await mkFilter(carol);
    const put = (b: any) => call(carol, 'PUT', `/rest/api/2/filter/${id}/share`, b);
    expect((await put({ shares: [{ type: 'user' }] })).status).toBe(400);
    expect((await put({ shares: [{ type: 'everyone' }] })).status).toBe(400);
    expect((await put({ shares: [{ type: 'global', id: 1 }] })).status).toBe(400);
    expect((await put({ shares: [{ type: 'user', id: -1 }] })).status).toBe(400);
    expect((await put({ shares: Array.from({ length: 101 }, () => ({ type: 'global' })) })).status).toBe(400);
    expect((await put({ shares: [], extra: 1 })).status).toBe(400);
    expect((await call(carol, 'PUT', `/rest/api/2/filter/${id}`, { authorId: ids.dave })).status).toBe(400); // mass assignment
    expect((await call(carol, 'POST', '/rest/api/2/filter', { name: 'x', jql: 'status = ', })).status).toBe(400); // bad JQL
    expect((await call(carol, 'POST', '/rest/api/2/filter', { name: '', jql: '' })).status).toBe(400);
    expect((await call(carol, 'POST', '/rest/api/2/filter', { name: 'x', jql: 'a'.repeat(6000) })).status).toBe(400);
    expect((await call(carol, 'GET', '/rest/api/2/filter/abc')).status).toBe(404);
    expect((await call(carol, 'GET', '/rest/api/2/filter/99999999999')).status).toBe(404);
    expect((await call('', 'GET', `/rest/api/2/filter/${id}`)).status).toBe(401);
  });

  test('legacy garbage in shares column never grants access or crashes', async () => {
    const id = await mkFilter(carol, { name: 'legacy' });
    await testSql`UPDATE filters SET shares = '"[]"'::jsonb WHERE id = ${Number(id)}`;
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(404);
    await testSql`UPDATE filters SET shares = '[{"type":"user","id":"abc"},{"type":"project"},5]'::jsonb WHERE id = ${Number(id)}`;
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}`)).status).toBe(404);
    expect((await call(dave, 'GET', '/rest/api/2/filter')).status).toBe(200);
  });

  test('filter search: name, owner, shared, paging', async () => {
    await mkFilter(carol, { name: 'Zeta search one', shares: [{ type: 'global' }] });
    await mkFilter(carol, { name: 'Zeta search two', shares: [{ type: 'global' }] });
    await mkFilter(carol, { name: 'Zeta private three' });
    const r = await (await call(dave, 'GET', '/rest/api/2/filter/search?name=zeta')).json();
    expect(r.values.map((f: any) => f.name)).toEqual(['Zeta search one', 'Zeta search two']);
    expect(r.total).toBe(2);
    const p = await (await call(dave, 'GET', '/rest/api/2/filter/search?name=zeta&maxResults=1&startAt=1')).json();
    expect(p.values.length).toBe(1);
    expect(p.isLast).toBe(true);
    const o = await (await call(dave, 'GET', '/rest/api/2/filter/search?owner=carol&name=zeta')).json();
    expect(o.total).toBe(2);
    expect((await (await call(dave, 'GET', '/rest/api/2/filter/search?owner=nobody-here')).json()).total).toBe(0);
    const mine = await (await call(carol, 'GET', '/rest/api/2/filter/search?name=zeta&shared=false')).json();
    expect(mine.total).toBe(3);
    const sharedWithMe = await (await call(carol, 'GET', '/rest/api/2/filter/search?name=zeta&shared=true')).json();
    expect(sharedWithMe.total).toBe(0);
    // like wildcards are literal
    expect((await (await call(dave, 'GET', '/rest/api/2/filter/search?name=%25')).json()).total).toBe(0);
    expect((await call(dave, 'GET', '/rest/api/2/filter/search?all=true')).status).toBe(403);
  });

  test('share-targets only reveal what the caller may share with', async () => {
    const proj = await (await call(dave, 'GET', '/rest/api/2/filter/share-targets?type=project')).json();
    expect(proj.values.map((v: any) => v.name).join()).toContain('TEST');
    expect(JSON.stringify(proj)).not.toContain('SECRET');
    expect((await (await call(erin, 'GET', '/rest/api/2/filter/share-targets?type=project')).json()).values).toEqual([]);
    const grp = await (await call(dave, 'GET', '/rest/api/2/filter/share-targets?type=group')).json();
    expect(grp.values).toEqual([]); // dave is in no group
    const grpErin = await (await call(erin, 'GET', '/rest/api/2/filter/share-targets?type=group')).json();
    expect(grpErin.values.map((v: any) => v.name)).toEqual(['devs']);
    const usr = await (await call(dave, 'GET', '/rest/api/2/filter/share-targets?type=user&q=ca')).json();
    expect(usr.values.length).toBe(1);
    expect(JSON.stringify(usr)).not.toContain('@'); // no emails
    expect((await call(dave, 'GET', '/rest/api/2/filter/share-targets?type=x')).status).toBe(400);
  });

  /* ---------------- JQL autocomplete ---------------- */

  test('autocomplete endpoints require authentication', async () => {
    for (const url of ['/rest/api/2/jql/autocompletedata', '/rest/api/2/jql/autocompletedata/suggestions?fieldName=status']) {
      expect((await call('', 'GET', url)).status).toBe(401);
    }
    expect((await call('', 'POST', '/rest/api/2/jql/validate', { jql: '' })).status).toBe(401);
    expect((await call('', 'POST', '/rest/api/2/jql/complete', { jql: '' })).status).toBe(401);
  });

  test('autocompletedata lists fields and functions', async () => {
    const d = await (await call(erin, 'GET', '/rest/api/2/jql/autocompletedata')).json();
    const status = d.visibleFieldNames.find((f: any) => f.value === 'status');
    expect(status.displayName.toLowerCase()).toBe('status');
    expect(status.operators).toContain('=');
    expect(d.visibleFunctionNames.map((f: any) => f.value)).toContain('currentUser()');
    expect(d.jqlReservedWords.map((w: string) => w.toLowerCase())).toContain('order');
  });

  test('suggestions: prefix filtering, limits and no email leakage', async () => {
    const q = async (qs: string) => (await (await call(erin, 'GET', `/rest/api/2/jql/autocompletedata/suggestions?${qs}`)).json()).results;
    expect((await q('fieldName=status&fieldValue=in')).map((r: any) => r.value)).toEqual(['In Progress']);
    expect((await q('fieldName=status')).length).toBe(2);
    expect((await q('fieldName=priority&fieldValue=med'))[0].value).toBe('Medium');
    expect(await q('fieldName=unknownfield')).toEqual([]);
    await db.insert(schema.users).values(Array.from({ length: 25 }, (_, i) => ({
      username: `bulk${i}`, email: `bulk${i}@example.com`, displayName: `Bulk ${i}`,
    })));
    const users = await q('fieldName=assignee&fieldValue=bulk');
    expect(users.length).toBeLessThanOrEqual(20);
    expect(users.length).toBeGreaterThan(0);
    expect(JSON.stringify(users)).not.toContain('@example.com');
    expect((await q('fieldName=assignee&fieldValue=bulk7'))[0].value).toBe('bulk7');
  });

  test('suggestions: projects, components and versions are limited to browsable projects', async () => {
    await db.insert(schema.components).values([
      { projectId: seeded.project.id, name: 'Frontend' }, { projectId: hiddenProjectId, name: 'SecretComponent' },
    ]);
    await db.insert(schema.versions).values([
      { projectId: seeded.project.id, name: 'v1.0' }, { projectId: hiddenProjectId, name: 'secret-v9' },
    ] as any);
    const get = async (cookie: string, field: string) =>
      (await (await call(cookie, 'GET', `/rest/api/2/jql/autocompletedata/suggestions?fieldName=${field}`)).json()).results;
    expect((await get(dave, 'project')).map((r: any) => r.value)).toEqual(['TEST']);
    expect((await get(admin, 'project')).map((r: any) => r.value).sort()).toEqual(['SECRET', 'TEST']);
    expect(await get(erin, 'project')).toEqual([]);
    expect((await get(dave, 'component')).map((r: any) => r.value)).toEqual(['Frontend']);
    expect(await get(erin, 'component')).toEqual([]);
    expect((await get(dave, 'fixversion')).map((r: any) => r.value)).toEqual(['v1.0']);
    expect(await get(erin, 'fixversion')).toEqual([]);
    expect((await get(admin, 'component')).length).toBe(2);
  });

  test('validate returns positions; complete returns context-aware suggestions', async () => {
    const v = await (await call(erin, 'POST', '/rest/api/2/jql/validate', { jql: 'status = Open AND foo = 1' })).json();
    expect(v.valid).toBe(false);
    expect(v.errors[0].pos).toBe(18);
    expect((await (await call(erin, 'POST', '/rest/api/2/jql/validate', { jql: 'status = "To Do"' })).json()).valid).toBe(true);
    expect((await call(erin, 'POST', '/rest/api/2/jql/validate', { jql: 1 })).status).toBe(400);
    expect((await call(erin, 'POST', '/rest/api/2/jql/validate', { jql: '', x: 1 })).status).toBe(400);

    const c1 = await (await call(erin, 'POST', '/rest/api/2/jql/complete', { jql: 'status = In' })).json();
    expect(c1.kind).toBe('value');
    expect(c1.suggestions.map((s: any) => s.insertText)).toEqual(['"In Progress"']);
    expect([c1.replaceFrom, c1.replaceTo]).toEqual([9, 11]);
    const c2 = await (await call(erin, 'POST', '/rest/api/2/jql/complete', { jql: 'sta' })).json();
    expect(c2.suggestions[0].value).toBe('status');
    const c3 = await (await call(erin, 'POST', '/rest/api/2/jql/complete', { jql: 'status = "To Do" ' })).json();
    expect(c3.suggestions.map((s: any) => s.value)).toEqual(['AND', 'OR', 'ORDER BY']);
    const c4 = await (await call(dave, 'POST', '/rest/api/2/jql/complete', { jql: 'project = ' })).json();
    expect(JSON.stringify(c4)).not.toContain('SECRET');
    expect(c4.suggestions.map((s: any) => s.value)).toContain('TEST');
  });

  /* ---------------- search permission trimming ---------------- */

  test('search results are trimmed to browsable projects', async () => {
    const keys = async (cookie: string, q = '') =>
      (await (await call(cookie, 'GET', `/rest/api/2/search?nocache=1${q}`)).json()).issues.map((i: any) => i.key);
    expect(await keys(admin)).toEqual(expect.arrayContaining(['TEST-1', 'SECRET-1']));
    expect(await keys(dave)).toEqual(['TEST-1']);
    expect(await keys(erin)).toEqual([]);
    expect(await keys(dave, '&jql=' + encodeURIComponent('key = "SECRET-1"'))).toEqual([]);
    expect(await keys(erin, '&jql=' + encodeURIComponent('summary ~ issue'))).toEqual([]);
    expect(await keys(dave, '&jql=' + encodeURIComponent('summary ~ issue ORDER BY created DESC'))).toEqual(['TEST-1']);
  });

  /* ---------------- subscriptions ---------------- */

  test('subscriptions: visibility, validation, upsert, delete', async () => {
    const id = await mkFilter(carol, { name: 'sub target' });
    const put = (cookie: string, b: any) => call(cookie, 'PUT', `/rest/api/2/filter/${id}/subscription`, b);
    expect((await put(dave, { schedule: 'daily', hour: 8 })).status).toBe(404); // private filter
    await call(carol, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [{ type: 'user', id: ids.dave }] });
    expect((await put(dave, { schedule: 'daily', hour: 24 })).status).toBe(400);
    expect((await put(dave, { schedule: 'hourly', hour: 1 })).status).toBe(400);
    expect((await put(dave, { schedule: 'weekly', hour: 1 })).status).toBe(400);
    expect((await put(dave, { schedule: 'weekly', hour: 1, weekday: 7 })).status).toBe(400);
    expect((await put(dave, { schedule: 'daily', hour: 1, userId: 3 })).status).toBe(400);
    const ok = await put(dave, { schedule: 'weekly', hour: 9, weekday: 1, emptyPolicy: 'send' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ schedule: 'weekly', hour: 9, weekday: 1, emptyPolicy: 'send' });
    const up = await put(dave, { schedule: 'daily', hour: 7, weekday: 3 });
    expect(await up.json()).toMatchObject({ schedule: 'daily', hour: 7, weekday: null, emptyPolicy: 'skip' });
    const rows = await db.select().from(schema.filterSubscriptions).where(eq(schema.filterSubscriptions.filterId, Number(id)));
    expect(rows.length).toBe(1);
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}/subscription`)).status).toBe(200);
    expect((await call(carol, 'GET', `/rest/api/2/filter/${id}/subscription`)).status).toBe(404); // carol's own: none
    // erin cannot delete dave's subscription
    await call(erin, 'DELETE', `/rest/api/2/filter/${id}/subscription`);
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}/subscription`)).status).toBe(200);
    // unsharing hides the subscription endpoints but dave can still delete his row
    await call(carol, 'PUT', `/rest/api/2/filter/${id}/share`, { shares: [] });
    expect((await call(dave, 'GET', `/rest/api/2/filter/${id}/subscription`)).status).toBe(404);
    expect((await call(dave, 'DELETE', `/rest/api/2/filter/${id}/subscription`)).status).toBe(200);
    expect((await db.select().from(schema.filterSubscriptions).where(eq(schema.filterSubscriptions.filterId, Number(id)))).length).toBe(0);
  });

  /* ---------------- digest ---------------- */

  describe('digest job', () => {
    const emails = () => db.select().from(schema.emailQueue);
    const clear = async () => {
      await testSql`TRUNCATE TABLE email_queue RESTART IDENTITY`;
      await testSql`TRUNCATE TABLE filter_subscriptions RESTART IDENTITY`;
    };
    // Tuesday 2030-01-08 10:00 UTC
    const now = new Date('2030-01-08T10:00:00Z');
    const created = new Date('2030-01-01T00:00:00Z');

    const subscribe = async (userId: number, filterId: string, extra: Record<string, any> = {}) =>
      db.insert(schema.filterSubscriptions).values({
        filterId: Number(filterId), userId, schedule: 'daily', hour: 8, emptyPolicy: 'skip', createdAt: created, ...extra,
      });

    test('sends one digest, permission-trimmed, escaped, only once per period', async () => {
      await clear();
      const fid = await mkFilter(carol, { name: 'All <b>issues</b>', jql: 'ORDER BY created DESC', shares: [{ type: 'global' }] });
      await subscribe(ids.dave, fid);
      await subscribe(ids.erin, fid); // erin cannot browse anything
      const r = await runFilterDigests(now);
      expect(r.sent).toBe(1);
      expect(r.skippedEmpty).toBe(1);
      const mails = await emails();
      expect(mails.length).toBe(1);
      expect(mails[0].toAddress).toBe('dave@example.com');
      expect(mails[0].htmlBody).toContain('TEST-1');
      expect(mails[0].htmlBody).not.toContain('SECRET-1');
      expect(mails[0].htmlBody).not.toContain('Hidden issue');
      expect(mails[0].htmlBody).not.toContain('<script>alert(1)</script>');
      expect(mails[0].htmlBody).toContain('&lt;script&gt;');
      expect(mails[0].htmlBody).not.toContain('<b>issues</b>');
      expect(mails[0].subject).toContain('Filter subscription');
      // second run in the same period: nothing
      const again = await runFilterDigests(new Date(now.getTime() + 5 * 60_000));
      expect(again.due).toBe(0);
      expect((await emails()).length).toBe(1);
      // next day: due again
      const next = await runFilterDigests(new Date('2030-01-09T08:05:00Z'));
      expect(next.sent).toBe(1);
    });

    test('empty results: skip policy sends nothing, send policy sends an empty digest', async () => {
      await clear();
      const fid = await mkFilter(dave, { name: 'nothing', jql: 'summary ~ "does-not-exist-anywhere"' });
      await subscribe(ids.dave, fid, { emptyPolicy: 'skip' });
      let r = await runFilterDigests(now);
      expect(r).toMatchObject({ sent: 0, skippedEmpty: 1 });
      expect((await emails()).length).toBe(0);
      await clear();
      await subscribe(ids.dave, fid, { emptyPolicy: 'send' });
      r = await runFilterDigests(now);
      expect(r.sent).toBe(1);
      const mails = await emails();
      expect(mails.length).toBe(1);
      expect(mails[0].htmlBody).toContain('No issues match');
    });

    test('not due before the scheduled hour, and new subscriptions wait for the next slot', async () => {
      await clear();
      const fid = await mkFilter(dave, { jql: 'ORDER BY created DESC' });
      await subscribe(ids.dave, fid, { hour: 12, createdAt: new Date('2030-01-08T00:00:00Z') });
      expect((await runFilterDigests(now)).due).toBe(0); // 12:00 not reached
      await clear();
      await subscribe(ids.dave, fid, { createdAt: new Date('2030-01-08T09:00:00Z') });
      expect((await runFilterDigests(now)).due).toBe(0); // created after today's 08:00 slot
      expect((await emails()).length).toBe(0);
    });

    test('subscription is dropped when the subscriber loses access to the filter; JQL runs as subscriber', async () => {
      await clear();
      const fid = await mkFilter(carol, { jql: 'assignee = currentUser()', shares: [{ type: 'user', id: ids.dave }] });
      await subscribe(ids.dave, fid, { emptyPolicy: 'send' });
      await call(carol, 'PUT', `/rest/api/2/filter/${fid}/share`, { shares: [] });
      const r = await runFilterDigests(now);
      expect(r.sent).toBe(0);
      expect((await db.select().from(schema.filterSubscriptions)).length).toBe(0);
      expect((await emails()).length).toBe(0);

      // currentUser() resolves to the subscriber: dave has nothing assigned, admin-assigned issue is not his.
      await clear();
      const fid2 = await mkFilter(dave, { jql: 'assignee = currentUser()' });
      await db.update(schema.issues).set({ assigneeId: seeded.user.id }).where(eq(schema.issues.issueKey, 'TEST-1'));
      await subscribe(ids.dave, fid2);
      const r2 = await runFilterDigests(now);
      expect(r2.skippedEmpty).toBe(1);
      await clear();
      await db.update(schema.issues).set({ assigneeId: ids.dave }).where(eq(schema.issues.issueKey, 'TEST-1'));
      await subscribe(ids.dave, fid2);
      expect((await runFilterDigests(now)).sent).toBe(1);
    });

    test('limits the digest to 50 issues but reports the total', async () => {
      await clear();
      await db.insert(schema.issues).values(Array.from({ length: 60 }, (_, i) => ({
        issueKey: `TEST-${100 + i}`, projectId: seeded.project.id, issueTypeId: seeded.issueType.id,
        statusId: seeded.status.id, summary: `bulk issue ${i}`, reporterId: seeded.user.id,
      })));
      const fid = await mkFilter(dave, { jql: 'summary ~ "bulk issue"' });
      await subscribe(ids.dave, fid);
      expect((await runFilterDigests(now)).sent).toBe(1);
      const [mail] = await emails();
      expect((mail.htmlBody.match(/\/issues\/TEST-\d+/g) || []).length).toBe(50);
      expect(mail.htmlBody).toContain('Showing 50 of 60');
    });
  });
});
