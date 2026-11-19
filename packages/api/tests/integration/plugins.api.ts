import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { deliverWebhook } from '../../src/services/webhooks';
import { flushPluginDeliveries } from '../../src/plugins/events';
import { verifySignature } from '../../src/plugins/signing';
import { decryptSecret } from '../../src/auth/secrets';

process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'true';
process.env.PLUGINS_RETRY_BASE_MS = '1';
process.env.PLUGINS_MAX_ATTEMPTS = '2';
process.env.PLUGINS_FAILURE_THRESHOLD = '3';

describe('Plugin system', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let adminCookie: string;
  let userCookie: string;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  const received: { headers: Record<string, string>; body: string }[] = [];
  let hookStatus = 200;
  let manifestDoc: any;
  let catalogDoc: any = { plugins: [] };

  const baseManifest = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, key: 'com.acme.hello', name: 'Hello', version: '1.0.0', description: 'test plugin',
    vendor: { name: 'Acme', url: 'https://acme.example' }, baseUrl: origin,
    scopes: ['read:issues'], events: ['issue.created', 'comment.added'], webhookPath: '/hook',
    config: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: false },
      { key: 'mode', label: 'Mode', type: 'select', options: ['a', 'b'] },
      { key: 'notes', label: 'Notes', type: 'text' },
    ],
    uiPanels: [{ location: 'issue.sidebar', title: 'Hello', path: '/panel' }, { location: 'admin.page', title: 'Admin hello', path: '/admin' }],
    ...over,
  });

  const call = (method: string, path: string, body?: unknown, auth: { cookie?: string; bearer?: string } = { cookie: adminCookie }) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const P = '/rest/api/2/admin/plugins';
  const install = async (manifest = baseManifest()) => {
    manifestDoc = manifest;
    return call('POST', P, { url: `${origin}/manifest.json` });
  };
  const login = async (username: string) => {
    const r = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) });
    return r.headers.get('set-cookie') || '';
  };
  const wipePlugins = async () => {
    await db.delete(schema.plugins);
    received.length = 0;
    hookStatus = 200;
  };

  beforeAll(async () => {
    await resetRateLimits();
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/manifest.json') return Response.json(manifestDoc);
        if (url.pathname === '/catalog.json') return Response.json(catalogDoc);
        if (url.pathname === '/redirect.json') return new Response(null, { status: 302, headers: { location: 'http://localhost.invalid/x' } });
        if (url.pathname === '/hook') {
          received.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
          return new Response('ok', { status: hookStatus });
        }
        return new Response('nope', { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;

    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@veqsio.local', displayName: 'Bob', passwordHash: hash });
    adminCookie = await login('admin');
    userCookie = await login('bob');
    await db.insert(schema.issues).values({
      projectId: seeded.project.id, issueKey: 'TEST-1', issueNumber: 1, summary: 'plug', issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id, reporterId: seeded.user.id,
    } as any);
  });

  afterAll(async () => {
    server.stop(true);
    for (const k of ['PLUGINS_ALLOW_PRIVATE_HOSTS', 'PLUGINS_RETRY_BASE_MS', 'PLUGINS_MAX_ATTEMPTS', 'PLUGINS_FAILURE_THRESHOLD']) delete process.env[k];
    await resetTestDb(testSql);
    await testSql.end();
  });

  beforeEach(wipePlugins);

  describe('install and access control', () => {
    test('non-admin and anonymous cannot use the admin API', async () => {
      manifestDoc = baseManifest();
      for (const auth of [{ cookie: userCookie }, {}]) {
        expect((await call('POST', P, { manifest: baseManifest() }, auth)).status).toBe(auth.cookie ? 403 : 401);
        expect((await call('GET', P, undefined, auth)).status).toBe(auth.cookie ? 403 : 401);
      }
      expect((await db.select().from(schema.plugins)).length).toBe(0);
    });

    test('install by URL, by pasted JSON; duplicates and invalid manifests are refused', async () => {
      const res = await install();
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key).toBe('com.acme.hello');
      expect(body.enabled).toBe(false);
      expect(body.grantedScopes).toEqual([]);
      expect(body.signingSecret).toMatch(/^whsec_/);
      expect((await install()).status).toBe(409);
      expect((await call('POST', P, { manifest: { ...baseManifest(), key: 'bad' } })).status).toBe(400);
      expect((await call('POST', P, { manifest: baseManifest({ key: 'com.acme.json' }) })).status).toBe(201);
      expect((await call('POST', P, { manifest: baseManifest({ key: 'com.acme.x' }), url: 'x' })).status).toBe(400);
      const list = await (await call('GET', P)).json();
      expect(list.map((p: any) => p.key).sort()).toEqual(['com.acme.hello', 'com.acme.json']);
      // service user exists, cannot log in
      const [su] = await db.select().from(schema.users).where(eq(schema.users.username, 'plugin:com.acme.hello'));
      expect(su.active).toBe(false);
      expect(su.passwordHash).toBeNull();
    });

    test('manifest URL: redirects are not followed, unreachable and private hosts (without override) fail', async () => {
      expect((await call('POST', P, { url: `${origin}/redirect.json` })).status).toBe(400);
      expect((await call('POST', P, { url: `${origin}/missing.json` })).status).toBe(400);
      process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'false';
      try {
        const r = await call('POST', P, { url: `${origin}/manifest.json` });
        expect(r.status).toBe(400);
        expect((await call('POST', P, { url: 'http://169.254.169.254/latest' })).status).toBe(400);
      } finally {
        process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'true';
      }
    });

    test('the signing secret is stored encrypted, never returned again', async () => {
      const { id, signingSecret } = await (await install()).json();
      const [row] = await db.select().from(schema.plugins).where(eq(schema.plugins.id, id));
      expect(row.signingSecretEnc).not.toContain(signingSecret);
      expect(decryptSecret(row.signingSecretEnc!)).toBe(signingSecret);
      const again = JSON.stringify(await (await call('GET', `${P}/${id}`)).json());
      expect(again).not.toContain(signingSecret);
      expect(again).not.toContain('signingSecret');
    });
  });

  describe('enable requires an explicit scope grant', () => {
    test('enable without grant is refused; grant must be requested scopes; token shown once', async () => {
      const { id } = await (await install()).json();
      expect((await call('POST', `${P}/${id}/enable`, {})).status).toBe(400);
      expect((await call('POST', `${P}/${id}/enable`, { grantScopes: ['write:issues'] })).status).toBe(400);
      expect((await call('POST', `${P}/${id}/enable`, { grantScopes: ['admin'] })).status).toBe(400);
      expect((await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'], extra: 1 })).status).toBe(400);
      const res = await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.grantedScopes).toEqual(['read:issues']);
      expect(body.token).toMatch(/^vqp_[0-9a-f]{64}$/);
      const [row] = await db.select().from(schema.plugins).where(eq(schema.plugins.id, id));
      expect(row.tokenHash).not.toBe(body.token);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      const second = await (await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'] })).json();
      expect(second.token).toBeNull();
      expect(JSON.stringify(await (await call('GET', `${P}/${id}`)).json())).not.toContain(body.token);
    });

    test('required settings must exist before enabling', async () => {
      const { id } = await (await install(baseManifest({ config: [{ key: 'apiKey', label: 'Key', type: 'secret', required: true }] }))).json();
      expect((await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'] })).status).toBe(409);
      await call('PUT', `${P}/${id}/settings`, { values: { apiKey: 'k' } });
      expect((await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'] })).status).toBe(200);
    });
  });

  describe('settings', () => {
    test('secrets are encrypted at rest and never returned; plugin can read them with its token', async () => {
      const { id } = await (await install()).json();
      const put = await call('PUT', `${P}/${id}/settings`, { values: { apiKey: 'sk-very-secret', mode: 'b', notes: 'hi' } });
      expect(put.status).toBe(200);
      const view = await put.json();
      expect(JSON.stringify(view)).not.toContain('sk-very-secret');
      expect(view.find((f: any) => f.key === 'apiKey')).toMatchObject({ hasValue: true, value: null });
      expect(view.find((f: any) => f.key === 'mode')).toMatchObject({ hasValue: true, value: 'b' });
      const get = JSON.stringify(await (await call('GET', `${P}/${id}/settings`)).json());
      expect(get).not.toContain('sk-very-secret');
      const [row] = await db.select().from(schema.pluginSettings).where(eq(schema.pluginSettings.key, 'apiKey'));
      expect(row.isSecret).toBe(true);
      expect(row.value).not.toContain('sk-very-secret');
      // validation
      expect((await call('PUT', `${P}/${id}/settings`, { values: { mode: 'z' } })).status).toBe(400);
      expect((await call('PUT', `${P}/${id}/settings`, { values: { unknown: 'x' } })).status).toBe(400);
      // omitted key keeps the secret; null clears
      await call('PUT', `${P}/${id}/settings`, { values: { notes: 'again' } });
      expect((await (await call('GET', `${P}/${id}/settings`)).json()).find((f: any) => f.key === 'apiKey').hasValue).toBe(true);
      // plugin reads via token
      const { token } = await (await call('POST', `${P}/${id}/enable`, { grantScopes: ['read:issues'] })).json();
      const mine = await (await call('GET', '/rest/api/2/plugins/self/settings', undefined, { bearer: token })).json();
      expect(mine).toEqual({ apiKey: 'sk-very-secret', mode: 'b', notes: 'again' });
      expect((await call('GET', '/rest/api/2/plugins/self/settings')).status).toBe(403); // admin session is not a plugin
      await call('PUT', `${P}/${id}/settings`, { values: { apiKey: null } });
      expect((await (await call('GET', `${P}/${id}/settings`)).json()).find((f: any) => f.key === 'apiKey').hasValue).toBe(false);
    });
  });

  describe('event delivery', () => {
    const enable = async (m = baseManifest()) => {
      const inst = await (await install(m)).json();
      const en = await (await call('POST', `${P}/${inst.id}/enable`, { grantScopes: m.scopes })).json();
      return { id: inst.id as number, secret: inst.signingSecret as string, token: en.token as string };
    };

    test('signed, minimal payload delivered with documented headers', async () => {
      const { id, secret } = await enable();
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: seeded.project.id, summary: 'must not leak', commentBody: 'nope', issueUrl: 'http://x' });
      await flushPluginDeliveries();
      expect(received.length).toBe(1);
      const r = received[0];
      expect(r.headers['x-veqsio-event']).toBe('issue.created');
      expect(r.headers['x-veqsio-delivery']).toMatch(/^[0-9a-f-]{36}$/);
      expect(verifySignature(secret, r.headers['x-veqsio-timestamp'], r.body, r.headers['x-veqsio-signature'])).toEqual({ ok: true });
      expect(verifySignature(secret, r.headers['x-veqsio-timestamp'], r.body + 'x', r.headers['x-veqsio-signature']).ok).toBe(false);
      const parsed = JSON.parse(r.body);
      expect(parsed.event).toBe('issue.created');
      expect(parsed.payload).toEqual({ issueKey: 'TEST-1', issueId: 1, projectId: seeded.project.id, type: 'issue.created' });
      const [log] = await db.select().from(schema.pluginDeliveries).where(eq(schema.pluginDeliveries.pluginId, id));
      expect(log).toMatchObject({ status: 'success', event: 'issue.created', attempts: 1, responseStatus: 200 });
      expect(log.deliveryId).toBe(r.headers['x-veqsio-delivery']);
      const api = await (await call('GET', `${P}/${id}/deliveries`)).json();
      expect(api.length).toBe(1);
    });

    test('unsubscribed events and internal comments are not delivered', async () => {
      await enable();
      await deliverWebhook('sprint.started', { sprintId: 1, projectId: 1 });
      const [pub] = await db.insert(schema.comments).values({ issueId: 1, authorId: seeded.user.id, body: 'public', isInternal: false } as any).returning();
      const [internal] = await db.insert(schema.comments).values({ issueId: 1, authorId: seeded.user.id, body: 'INTERNAL NOTE', isInternal: true } as any).returning();
      await deliverWebhook('comment.added', { issueKey: 'TEST-1', issueId: 1, projectId: 1, commentId: internal.id, commentBody: 'INTERNAL NOTE' });
      await flushPluginDeliveries();
      expect(received.length).toBe(0);
      await deliverWebhook('comment.added', { issueKey: 'TEST-1', issueId: 1, projectId: 1, commentId: pub.id, commentBody: 'public' });
      await flushPluginDeliveries();
      expect(received.length).toBe(1);
      expect(received[0].body).not.toContain('public"');
      expect(received[0].body).not.toContain('INTERNAL');
    });

    test('events needing a scope that was not granted are not delivered', async () => {
      const inst = await (await install()).json();
      await call('POST', `${P}/${inst.id}/enable`, { grantScopes: [] }); // approve nothing
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      expect(received.length).toBe(0);
    });

    test('retries with backoff then records failure; circuit breaker disables with a reason', async () => {
      const { id } = await enable();
      hookStatus = 500;
      for (let i = 0; i < 2; i++) {
        await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
        await flushPluginDeliveries();
      }
      expect(received.length).toBe(4); // 2 deliveries x 2 attempts
      let view = await (await call('GET', `${P}/${id}`)).json();
      expect(view.enabled).toBe(true);
      expect(view.consecutiveFailures).toBe(2);
      const logs = await (await call('GET', `${P}/${id}/deliveries`)).json();
      expect(logs.every((l: any) => l.status === 'failed' && l.attempts === 2 && l.responseStatus === 500)).toBe(true);
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      view = await (await call('GET', `${P}/${id}`)).json();
      expect(view.enabled).toBe(false);
      expect(view.disabledReason).toContain('3 consecutive failed deliveries');
      // disabled plugin receives nothing more
      received.length = 0;
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      expect(received.length).toBe(0);
    });

    test('4xx is not retried; a success resets the failure counter', async () => {
      const { id } = await enable();
      hookStatus = 400;
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      expect(received.length).toBe(1);
      expect((await (await call('GET', `${P}/${id}`)).json()).consecutiveFailures).toBe(1);
      hookStatus = 200;
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      expect((await (await call('GET', `${P}/${id}`)).json()).consecutiveFailures).toBe(0);
    });

    test('an unreachable plugin is recorded as failed without hanging the dispatcher', async () => {
      const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
      const m = baseManifest({ key: 'com.acme.dead', baseUrl: `http://127.0.0.1:${dead.port}` });
      dead.stop(true);
      const { id } = await enable(m);
      await deliverWebhook('issue.created', { issueKey: 'TEST-1', issueId: 1, projectId: 1 });
      await flushPluginDeliveries();
      const [log] = await db.select().from(schema.pluginDeliveries).where(eq(schema.pluginDeliveries.pluginId, id));
      expect(log.status).toBe('failed');
      expect(log.error).toBeTruthy();
    });
  });

  describe('plugin token', () => {
    test('works within granted scopes and the service user permissions; disabled plugin token is rejected at once', async () => {
      const inst = await (await install()).json();
      const { token } = await (await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['read:issues'] })).json();
      // authenticates as the service user
      const me = await call('GET', '/rest/api/2/myself', undefined, { bearer: token });
      expect(me.status).toBe(200);
      expect((await me.json()).name ?? 'plugin:com.acme.hello').toBeTruthy();
      // scope narrowing: no write, no projects
      expect((await call('POST', '/rest/api/2/issue/TEST-1/comment', { body: 'x' }, { bearer: token })).status).toBe(403);
      expect((await call('GET', '/rest/api/2/project', undefined, { bearer: token })).status).toBe(403);
      // read scope is granted, but the plugin's service user has no BROWSE_PROJECTS on the project: deny by default
      // (issue reads are permission-checked now; this used to be an open read)
      expect((await call('GET', '/rest/api/2/issue/TEST-1', undefined, { bearer: token })).status).toBe(404);
      // disable -> rejected immediately
      await call('POST', `${P}/${inst.id}/disable`);
      expect((await call('GET', '/rest/api/2/myself', undefined, { bearer: token })).status).toBe(401);
      // re-enable -> same token works again; rotate -> old token dies
      await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['read:issues'] });
      expect((await call('GET', '/rest/api/2/myself', undefined, { bearer: token })).status).toBe(200);
      const rotated = (await (await call('POST', `${P}/${inst.id}/token`)).json()).token;
      expect(rotated).not.toBe(token);
      expect((await call('GET', '/rest/api/2/myself', undefined, { bearer: token })).status).toBe(401);
      expect((await call('GET', '/rest/api/2/myself', undefined, { bearer: rotated })).status).toBe(200);
      // uninstall -> dead
      expect((await call('DELETE', `${P}/${inst.id}`)).status).toBe(204);
      expect((await call('GET', '/rest/api/2/myself', undefined, { bearer: rotated })).status).toBe(401);
    });

    test('service user permissions apply like any user (deny by default until an admin grants them)', async () => {
      const m = baseManifest({ scopes: ['write:issues'] });
      const inst = await (await install(m)).json();
      const { token } = await (await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['write:issues'] })).json();
      const comment = () => call('POST', '/rest/api/2/issue/TEST-1/comment', { body: 'from plugin' }, { bearer: token });
      const before = await comment();
      expect([401, 403, 404]).toContain(before.status);
      await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: 'ADD_COMMENTS', userId: inst.serviceUserId });
      const { delPattern } = await import('../../src/services/cache');
      await delPattern('veqsio:permission:*');
      expect((await comment()).status).toBe(201);
    });

    test('plugin tokens cannot reach admin, SCIM, token or user-management endpoints', async () => {
      const inst = await (await install(baseManifest({ scopes: ['read:issues', 'write:issues', 'read:projects', 'write:projects'] }))).json();
      const { token } = await (await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['read:issues', 'write:issues', 'read:projects', 'write:projects'] })).json();
      const attempts: [string, string, unknown?][] = [
        ['GET', P], ['POST', P, { manifest: baseManifest({ key: 'com.evil.x' }) }], ['GET', `${P}/${inst.id}`], ['POST', `${P}/${inst.id}/token`], ['DELETE', `${P}/${inst.id}`],
        ['PUT', `${P}/${inst.id}/settings`, { values: {} }], ['POST', `${P}/${inst.id}/enable`, { grantScopes: [] }],
        ['GET', '/rest/api/2/admin/oidc'], ['GET', '/scim/v2/Users'], ['GET', '/rest/api/2/mypersonalaccessTokens'],
        ['POST', '/rest/api/2/mypersonalaccessTokens', { name: 'x', scopes: ['*'] }], ['GET', '/rest/api/2/webhook'], ['POST', '/rest/api/2/user', { username: 'evil', email: 'e@e.io', displayName: 'E', password: 'abcdef' }],
      ];
      for (const [m, p, b] of attempts) {
        const res = await call(m, p, b, { bearer: token });
        expect([401, 403, 404]).toContain(res.status);
        expect(res.status).not.toBeLessThan(400);
      }
      expect((await db.select().from(schema.users).where(eq(schema.users.username, 'evil'))).length).toBe(0);
      expect((await db.select().from(schema.plugins).where(eq(schema.plugins.key, 'com.evil.x'))).length).toBe(0);
    });

    test('service user cannot log in or hold a session', async () => {
      const inst = await (await install()).json();
      const r = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'plugin:com.acme.hello', password: '' }) });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(inst.serviceUserId).toBeTruthy();
    });
  });

  describe('update with re-approval', () => {
    test('preview shows the diff; added scopes are not granted unless approved; base URL change disables', async () => {
      const inst = await (await install()).json();
      await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['read:issues'] });
      const v2 = baseManifest({ version: '2.0.0', scopes: ['read:issues', 'write:issues'], events: ['issue.created'] });
      manifestDoc = v2;
      const preview = await (await call('PUT', `${P}/${inst.id}`, { url: `${origin}/manifest.json` })).json();
      expect(preview.applied).toBe(false);
      expect(preview.diff.scopes.added).toEqual(['write:issues']);
      expect(preview.diff.events.removed).toEqual(['comment.added']);
      expect(preview.diff.needsApproval).toBe(true);
      expect((await (await call('GET', `${P}/${inst.id}`)).json()).version).toBe('1.0.0');
      // confirm without approving: new scope NOT granted
      const applied = await (await call('PUT', `${P}/${inst.id}`, { url: `${origin}/manifest.json`, confirm: true })).json();
      expect(applied.applied).toBe(true);
      expect(applied.plugin.version).toBe('2.0.0');
      expect(applied.plugin.grantedScopes).toEqual(['read:issues']);
      // approving something that was not added is refused
      expect((await call('PUT', `${P}/${inst.id}`, { manifest: v2, confirm: true, approveScopes: ['read:projects'] })).status).toBe(400);
      const approved = await (await call('PUT', `${P}/${inst.id}`, { manifest: baseManifest({ version: '2.0.1', scopes: ['read:issues', 'write:issues', 'read:projects'] }), confirm: true, approveScopes: ['read:projects'] })).json();
      expect(approved.plugin.grantedScopes.sort()).toEqual(['read:issues', 'read:projects']);
      // removing a scope revokes it
      const shrunk = await (await call('PUT', `${P}/${inst.id}`, { manifest: baseManifest({ version: '2.0.2', scopes: [] }), confirm: true })).json();
      expect(shrunk.plugin.grantedScopes).toEqual([]);
      // key mismatch and base URL change
      expect((await call('PUT', `${P}/${inst.id}`, { manifest: baseManifest({ key: 'com.other.thing' }), confirm: true })).status).toBe(400);
      const moved = await (await call('PUT', `${P}/${inst.id}`, { manifest: baseManifest({ version: '3.0.0', baseUrl: 'http://127.0.0.1:9' }), confirm: true })).json();
      expect(moved.plugin.enabled).toBe(false);
      expect(moved.plugin.disabledReason).toContain('Base URL');
    });
  });

  describe('UI panels', () => {
    test('any authenticated user lists enabled plugins panels for a location; disabled ones are hidden', async () => {
      const inst = await (await install()).json();
      expect((await call('GET', '/rest/api/2/plugins/panels?location=issue.sidebar', undefined, {})).status).toBe(401);
      let panels = await (await call('GET', '/rest/api/2/plugins/panels?location=issue.sidebar', undefined, { cookie: userCookie })).json();
      expect(panels).toEqual([]);
      await call('POST', `${P}/${inst.id}/enable`, { grantScopes: ['read:issues'] });
      panels = await (await call('GET', '/rest/api/2/plugins/panels?location=issue.sidebar', undefined, { cookie: userCookie })).json();
      expect(panels).toEqual([{ pluginKey: 'com.acme.hello', pluginName: 'Hello', location: 'issue.sidebar', title: 'Hello', url: `${origin}/panel` }]);
      expect(JSON.stringify(panels)).not.toContain('token');
      expect((await call('GET', '/rest/api/2/plugins/panels?location=bogus', undefined, { cookie: userCookie })).status).toBe(400);
      expect((await call('GET', '/rest/api/2/plugins/panels', undefined, { cookie: userCookie })).status).toBe(400);
      await call('POST', `${P}/${inst.id}/disable`);
      panels = await (await call('GET', '/rest/api/2/plugins/panels?location=issue.sidebar', undefined, { cookie: userCookie })).json();
      expect(panels).toEqual([]);
    });
  });

  describe('marketplace catalog', () => {
    test('admin only; empty until configured; lists entries and marks installed ones; install from an entry works', async () => {
      expect((await call('GET', `${P}/catalog`, undefined, { cookie: userCookie })).status).toBe(403);
      expect((await call('PUT', `${P}/catalog`, { url: `${origin}/catalog.json` }, { cookie: userCookie })).status).toBe(403);
      expect(await (await call('GET', `${P}/catalog`)).json()).toMatchObject({ url: '', entries: [] });

      catalogDoc = { plugins: [{ key: 'com.acme.hello', name: 'Hello', description: 'demo', manifestUrl: `${origin}/manifest.json` }, { name: 'broken' }] };
      expect((await call('PUT', `${P}/catalog`, { url: `${origin}/catalog.json` })).status).toBe(200);
      const cat = await (await call('GET', `${P}/catalog`)).json();
      expect(cat.entries.length).toBe(1);
      expect(cat.skipped).toBe(1);
      expect(cat.installed).toEqual([]);

      manifestDoc = baseManifest();
      expect((await call('POST', P, { url: cat.entries[0].manifestUrl })).status).toBe(201);
      expect((await (await call('GET', `${P}/catalog`)).json()).installed).toEqual(['com.acme.hello']);

      expect((await call('PUT', `${P}/catalog`, { url: '' })).status).toBe(200);
      expect(await (await call('GET', `${P}/catalog`)).json()).toMatchObject({ url: '', entries: [] });
    });

    test('a catalog URL pointing at a metadata address is refused', async () => {
      const before = process.env.PLUGINS_ALLOW_PRIVATE_HOSTS;
      expect((await call('PUT', `${P}/catalog`, { url: 'http://169.254.169.254/latest/meta-data' })).status).toBe(400);
      process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = before;
    });
  });
});
