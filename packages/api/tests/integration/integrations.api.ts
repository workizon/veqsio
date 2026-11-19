import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { hmacHex } from '../../src/integrations/verify';
import { invalidateFeatures, invalidateProjectFeatures } from '../../src/features';
import { flushChatNotifications, setNotifyFetch } from '../../src/integrations/notify';
import { deliverWebhook } from '../../src/services/webhooks';

describe('Integrations: inbound webhooks, Sentry intake, Slack / Teams', () => {
  let seeded: any;
  let cookie = '';
  let bobCookie = '';
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const saved: Record<string, string | undefined> = {};

  const call = (method: string, path: string, body?: unknown, ck = cookie) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
  const post = (slug: string, raw: string, headers: Record<string, string> = {}) =>
    app.request(`/rest/api/2/webhooks/inbound/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
  const signed = (src: { slug: string; secret: string }, payload: unknown, extra: Record<string, string> = {}) => {
    const raw = JSON.stringify(payload);
    return post(src.slug, raw, { 'X-Veqsio-Signature': `sha256=${hmacHex(src.secret, raw)}`, ...extra });
  };
  const slugOf = (url: string) => url.split('/').pop()!;
  const issueByKey = async (key: string) => (await (await call('GET', `/rest/api/2/issue/${key}`)).json());

  const mapping = {
    summary: '[{{alerts[0].labels.alertname}}] {{alerts[0].annotations.summary}}',
    description: '{{alerts[0].annotations.description}}',
    comment: 'Alert fired again: {{alerts[0].annotations.summary}}',
    priority: '{{alerts[0].labels.severity}}',
    priorityMap: { critical: 'Highest', warning: 'High' },
    labels: ['alert'],
    dedupKey: '{{alerts[0].fingerprint}}',
    resolvedWhen: { path: 'status', equals: 'resolved' },
  };
  const alert = (fp: string, status = 'firing', severity = 'critical') => ({
    status, password: 'hunter2',
    alerts: [{ labels: { alertname: 'HighCPU', severity }, annotations: { summary: 'CPU > 90%', description: 'Node a1 is hot' }, fingerprint: fp }],
  });

  let grafana: { id: number; slug: string; secret: string; url: string };

  beforeAll(async () => {
    for (const k of ['PLUGINS_ALLOW_PRIVATE_HOSTS', 'NOTIFY_RETRY_BASE_MS', 'NOTIFY_RATE_PER_MINUTE', 'INBOUND_RATE_LIMIT_MAX', 'INBOUND_BODY_LIMIT_BYTES']) saved[k] = process.env[k];
    process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.NOTIFY_RETRY_BASE_MS = '1';
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: await bcrypt.hash('bob12345', 12) });
    const login = async (u: string, p: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie') || '';
    cookie = await login('admin', 'admin123');
    bobCookie = await login('bob', 'bob12345');
    // A done status reachable from the initial status, and the priorities the mappings use.
    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#00aa00' }).returning();
    await db.insert(schema.workflowTransitions).values({
      workflowId: seeded.workflow.id, name: 'Resolve', fromStatusId: seeded.status.id, toStatusId: done.id,
      conditions: JSON.stringify([{ type: 'always_true' }]), validators: JSON.stringify([]), postFunctions: JSON.stringify([]),
    });
    await db.insert(schema.priorities).values([{ name: 'Highest', color: '#f00' }, { name: 'High', color: '#f80' }]);
  });
  afterAll(async () => {
    setNotifyFetch(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    invalidateFeatures(); invalidateProjectFeatures();
    await resetTestDb(testSql); await testSql.end();
  });

  /* ------------------------------ sources ------------------------------ */

  test('only project admins manage sources; the secret is shown once', async () => {
    expect((await call('GET', '/rest/api/2/project/TEST/inbound-sources', undefined, bobCookie)).status).toBe(403);
    expect((await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'x' }, bobCookie)).status).toBe(403);
    expect((await app.request('/rest/api/2/project/TEST/inbound-sources')).status).toBe(401);
    expect((await call('POST', '/rest/api/2/project/NOPE/inbound-sources', { name: 'x' })).status).toBe(404);

    const res = await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Grafana', mapping });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret.length).toBeGreaterThan(30);
    expect(body.url).toContain('/rest/api/2/webhooks/inbound/');
    expect(body.signatureHeader).toBe('X-Veqsio-Signature');
    grafana = { id: body.id, slug: slugOf(body.url), secret: body.secret, url: body.url };

    const list = await (await call('GET', '/rest/api/2/project/TEST/inbound-sources')).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(grafana.secret);
    expect(list[0].secret).toBeUndefined();
    // stored encrypted, not in the clear
    const [row] = await db.select().from(schema.inboundSources).where(eq(schema.inboundSources.id, grafana.id));
    expect(row.secretEnc).not.toContain(grafana.secret);
    expect(row.secretEnc.startsWith('v1.')).toBe(true);

    expect((await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Grafana' })).status).toBe(409);
  });

  test('validates mappings, unknown keys and targets', async () => {
    const mk = (extra: any) => call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Bad', ...extra });
    expect((await mk({ mapping: { summary: '{{a | exec}}' } })).status).toBe(400);
    expect((await mk({ mapping: { evil: 1 } })).status).toBe(400);
    expect((await mk({ mapping: { resolvedWhen: { path: 'a..b', equals: 'x' } } })).status).toBe(400);
    expect((await mk({ unknown: 1 })).status).toBe(400);
    expect((await mk({ issueTypeId: 99999 })).status).toBe(400);
    expect((await mk({ actorUserId: 99999 })).status).toBe(400);
  });

  /* ------------------------------ ingestion ------------------------------ */

  test('happy path: a signed alert creates an issue with mapped fields', async () => {
    const res = await signed(grafana, alert('fp-1'));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.status).toBe('created');
    const issue = await issueByKey(out.key);
    expect(issue.fields.summary).toBe('[HighCPU] CPU > 90%');
    expect(issue.fields.description).toContain('Node a1 is hot');
    expect(issue.fields.description).toContain('external system');
    expect(issue.fields.priority.name).toBe('Highest');
    expect(issue.fields.labels).toContain('alert');
  });

  test('bad or missing signature is 401 and creates nothing', async () => {
    const before = (await db.select().from(schema.issues)).length;
    const raw = JSON.stringify(alert('fp-bad'));
    expect((await post(grafana.slug, raw)).status).toBe(401);
    expect((await post(grafana.slug, raw, { 'X-Veqsio-Signature': `sha256=${hmacHex('wrong', raw)}` })).status).toBe(401);
    expect((await post(grafana.slug, raw, { 'X-Veqsio-Signature': `sha256=${hmacHex(grafana.secret, raw + ' ')}` })).status).toBe(401); // body altered
    expect((await post('does-not-exist', raw)).status).toBe(404);
    expect((await db.select().from(schema.issues)).length).toBe(before);
  });

  test('invalid JSON after a valid signature is 400; scalars are refused', async () => {
    const raw = '{not json';
    expect((await post(grafana.slug, raw, { 'X-Veqsio-Signature': `sha256=${hmacHex(grafana.secret, raw)}` })).status).toBe(400);
    const scalar = '42';
    expect((await post(grafana.slug, scalar, { 'X-Veqsio-Signature': `sha256=${hmacHex(grafana.secret, scalar)}` })).status).toBe(400);
  });

  test('retries with the same idempotency key do not duplicate', async () => {
    const p = alert('fp-idem');
    const first = await signed(grafana, p, { 'Idempotency-Key': 'delivery-1' });
    expect(first.status).toBe(201);
    const second = await signed(grafana, p, { 'Idempotency-Key': 'delivery-1' });
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe('duplicate');
    const issues = await db.select().from(schema.issues).where(eq(schema.issues.summary, '[HighCPU] CPU > 90%'));
    const links = await db.select().from(schema.inboundLinks).where(eq(schema.inboundLinks.dedupKey, 'fp-idem'));
    expect(links).toHaveLength(1);
    expect(issues.length).toBeGreaterThanOrEqual(2); // fp-1 and fp-idem, not three
    expect(issues.filter((i) => i.id === links[0].issueId)).toHaveLength(1);
  });

  test('same fingerprint: the open issue gets a comment, a resolved payload transitions it, a later one opens a new issue', async () => {
    const created = await (await signed(grafana, alert('fp-dedup'))).json();
    expect(created.status).toBe('created');

    const again = await signed(grafana, alert('fp-dedup'));
    expect(again.status).toBe(200);
    const c = await again.json();
    expect(c.status).toBe('commented');
    expect(c.key).toBe(created.key);
    const comments = (await (await call('GET', `/rest/api/2/issue/${created.key}/comment`)).json()).comments.map((x: any) => x.body);
    expect(comments).toContain('Alert fired again: CPU > 90%');

    const res = await signed(grafana, alert('fp-dedup', 'resolved'));
    expect((await res.json()).status).toBe('transitioned');
    expect((await issueByKey(created.key)).fields.status.name).toBe('Done');

    // resolved again: nothing open any more
    expect((await (await signed(grafana, alert('fp-dedup', 'resolved'))).json()).status).toBe('ignored');
    // firing again after resolution: a new issue
    const reopened = await (await signed(grafana, alert('fp-dedup'))).json();
    expect(reopened.status).toBe('created');
    expect(reopened.key).not.toBe(created.key);
    // resolved for an unknown fingerprint is ignored
    expect((await (await signed(grafana, alert('fp-unknown', 'resolved'))).json()).status).toBe('ignored');
  });

  test('concurrent alerts with one fingerprint create a single issue', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => signed(grafana, alert('fp-race'))));
    const statuses = await Promise.all(results.map(async (r) => (await r.json()).status));
    expect(statuses.filter((s) => s === 'created')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'commented')).toHaveLength(3);
  });

  test('delivery log keeps redacted, capped payloads and outcomes', async () => {
    const log = await (await call('GET', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/deliveries`)).json();
    expect(log.length).toBeGreaterThan(5);
    const joined = JSON.stringify(log);
    expect(joined).not.toContain('hunter2');
    expect(joined).toContain('[redacted]');
    expect(log.map((d: any) => d.status)).toEqual(expect.arrayContaining(['created', 'commented', 'transitioned', 'duplicate'].filter((s) => s !== 'duplicate')));
    expect(log.some((d: any) => d.dedupKey === 'fp-dedup' && d.issueKey)).toBe(true);
    expect((await call('GET', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/deliveries`, undefined, bobCookie)).status).toBe(403);
  });

  test('dry run previews the mapping and planned action without side effects', async () => {
    const before = (await db.select().from(schema.issues)).length;
    const res = await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/test`, { payload: alert('fp-dry') });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.dryRun).toBe(true);
    expect(out.normalized.summary).toBe('[HighCPU] CPU > 90%');
    expect(out.normalized.priority).toBe('Highest');
    expect(out.plan.action).toBe('create');
    const existing = await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/test`, { payload: alert('fp-race') });
    expect((await existing.json()).plan.action).toBe('comment');
    expect((await db.select().from(schema.issues)).length).toBe(before);
    expect((await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/test`, { payload: alert('x') }, bobCookie)).status).toBe(403);
    expect((await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/test`, { nope: 1 })).status).toBe(400);
  });

  test('a real test delivery creates an issue and is flagged as a test in the log', async () => {
    const res = await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/test`, { payload: alert('fp-test'), dryRun: false });
    expect((await res.json()).status).toBe('created');
    const log = await (await call('GET', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/deliveries?limit=1`)).json();
    expect(log[0].isTest).toBe(true);
  });

  test('rotating the secret invalidates the old one', async () => {
    const res = await call('POST', `/rest/api/2/project/TEST/inbound-sources/${grafana.id}/rotate-secret`);
    expect(res.status).toBe(200);
    const { secret } = await res.json();
    expect(secret).not.toBe(grafana.secret);
    expect((await signed(grafana, alert('fp-rot'))).status).toBe(401);
    grafana.secret = secret;
    expect((await signed(grafana, alert('fp-rot'))).status).toBe(201);
  });

  test('shared secret header mode', async () => {
    const created = await (await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Plain', authMode: 'header', mapping: { summary: '{{title}}', dedupKey: '{{id}}' } })).json();
    const slug = slugOf(created.url);
    expect(created.signatureHeader).toBe('X-Veqsio-Secret');
    const raw = JSON.stringify({ title: 'From script', id: 'p1' });
    expect((await post(slug, raw)).status).toBe(401);
    expect((await post(slug, raw, { 'X-Veqsio-Secret': 'nope' })).status).toBe(401);
    expect((await post(slug, raw, { 'X-Veqsio-Secret': created.secret })).status).toBe(201);
    expect((await post(slug, raw, { Authorization: `Bearer ${created.secret}` })).status).toBe(200); // comment on the open issue
  });

  test('disabled sources and deleted sources answer 404', async () => {
    const s = await (await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Temp', mapping: { summary: '{{t}}' } })).json();
    const src = { slug: slugOf(s.url), secret: s.secret };
    expect((await signed(src, { t: 'a' })).status).toBe(201);
    expect((await call('PUT', `/rest/api/2/project/TEST/inbound-sources/${s.id}`, { enabled: false })).status).toBe(200);
    expect((await signed(src, { t: 'b' })).status).toBe(404);
    expect((await call('DELETE', `/rest/api/2/project/TEST/inbound-sources/${s.id}`)).status).toBe(200);
    expect((await signed(src, { t: 'c' })).status).toBe(404);
  });

  test('rate limit per source and IP', async () => {
    process.env.INBOUND_RATE_LIMIT_MAX = '4';
    const s = await (await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Limited', mapping: { summary: '{{t}}' } })).json();
    const src = { slug: slugOf(s.url), secret: s.secret };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await signed(src, { t: `n${i}` })).status);
    delete process.env.INBOUND_RATE_LIMIT_MAX;
    expect(codes.slice(0, 4).every((c) => c === 201)).toBe(true);
    expect(codes.slice(4)).toEqual([429, 429]);
  });

  test('body size limit', async () => {
    process.env.INBOUND_BODY_LIMIT_BYTES = '1000';
    const raw = JSON.stringify({ title: 'x'.repeat(3000) });
    const res = await signed(grafana, JSON.parse(raw));
    delete process.env.INBOUND_BODY_LIMIT_BYTES;
    expect(res.status).toBe(413);
  });

  /* ------------------------------ Sentry ------------------------------ */

  test('Sentry source: signature header, level -> priority, dedup on issue id, resolve', async () => {
    const res = await call('POST', '/rest/api/2/project/TEST/inbound-sources', { name: 'Sentry', type: 'sentry', authMode: 'header' });
    expect(res.status).toBe(201);
    const s = await res.json();
    expect(s.authMode).toBe('hmac'); // forced
    expect(s.signatureHeader).toBe('Sentry-Hook-Signature');
    const slug = slugOf(s.url);
    const send = (payload: unknown, secret = s.secret, extra: Record<string, string> = {}) => {
      const raw = JSON.stringify(payload);
      return post(slug, raw, { 'Sentry-Hook-Signature': hmacHex(secret, raw), ...extra });
    };
    const event = { action: 'triggered', data: { event: { issue_id: '777', title: 'TypeError in checkout', culprit: 'checkout.js in pay', level: 'error', web_url: 'https://sentry.example/issues/777/', environment: 'production' }, triggered_rule: 'Prod errors' } };

    const raw = JSON.stringify(event);
    expect((await post(slug, raw)).status).toBe(401);
    expect((await send(event, 'wrong')).status).toBe(401);
    expect((await post(slug, raw, { 'X-Veqsio-Signature': `sha256=${hmacHex(s.secret, raw)}` })).status).toBe(401); // wrong header for this type

    const created = await send(event);
    expect(created.status).toBe(201);
    const key = (await created.json()).key;
    const issue = await issueByKey(key);
    expect(issue.fields.summary).toBe('TypeError in checkout');
    expect(issue.fields.priority.name).toBe('High');
    expect(issue.fields.description).toContain('checkout.js in pay');
    expect(issue.fields.description).toContain('https://sentry.example/issues/777/');
    expect(issue.fields.labels).toEqual(expect.arrayContaining(['sentry', 'sentry-error']));

    const again = await (await send(event)).json();
    expect(again).toMatchObject({ status: 'commented', key });
    // Sentry retry carries the same Request-ID
    const withId = { ...event, data: { ...event.data, event: { ...event.data.event, issue_id: '778' } } };
    expect((await send(withId, s.secret, { 'Request-ID': 'req-1' })).status).toBe(201);
    expect((await (await send(withId, s.secret, { 'Request-ID': 'req-1' })).json()).status).toBe('duplicate');

    const resolved = { action: 'resolved', data: { issue: { id: '777', title: 'TypeError in checkout', level: 'error', status: 'resolved', permalink: 'https://sentry.example/issues/777/' } } };
    expect((await (await send(resolved)).json()).status).toBe('transitioned');
    expect((await issueByKey(key)).fields.status.name).toBe('Done');

    // installation events and other shapes are acknowledged but ignored
    expect((await (await send({ action: 'created', installation: { uuid: 'x' } })).json()).status).toBe('ignored');
  });

  /* ------------------------------ feature switch ------------------------------ */

  test('feature switch closes the endpoints for the instance and per project', async () => {
    const adminUrl = `/rest/api/2/project/TEST/inbound-sources`;
    expect((await call('PUT', '/rest/api/2/admin/features/integrations', { enabled: false })).status).toBe(200);
    invalidateFeatures();
    expect((await signed(grafana, alert('fp-off'))).status).toBe(404);
    expect((await call('GET', adminUrl)).status).toBe(404);
    expect((await call('GET', '/rest/api/2/admin/notification-channels')).status).toBe(404);
    expect((await call('PUT', '/rest/api/2/admin/features/integrations', { enabled: true })).status).toBe(200);
    invalidateFeatures();
    expect((await signed(grafana, alert('fp-on'))).status).toBe(201);

    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { integrations: false } })).status).toBe(200);
    invalidateFeatures(); invalidateProjectFeatures();
    expect((await signed(grafana, alert('fp-proj-off'))).status).toBe(404);
    expect((await call('GET', adminUrl)).status).toBe(404);
    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { integrations: true } })).status).toBe(200);
    invalidateProjectFeatures();
    expect((await signed(grafana, alert('fp-proj-on'))).status).toBe(201);
  });

  /* ------------------------------ chat channels ------------------------------ */

  const SLACK = 'https://203.0.113.10/services/T000/B000/secrettoken';
  const TEAMS = 'https://203.0.113.11/webhookb2/abc/IncomingWebhook/def';
  let slack: any;
  let teams: any;
  const calls: { url: string; body: any }[] = [];
  let respond: (n: number) => number = () => 200;

  test('channels: project admins only, SSRF-guarded, URL encrypted and masked', async () => {
    const base = '/rest/api/2/project/TEST/notification-channels';
    expect((await call('GET', base, undefined, bobCookie)).status).toBe(403);
    expect((await app.request(base)).status).toBe(401);
    expect((await call('POST', base, { type: 'slack', name: 'x', url: SLACK, events: ['issue.created'] }, bobCookie)).status).toBe(403);

    // SSRF refusals: metadata address (always), private + localhost + http when private hosts are not allowed
    expect((await call('POST', base, { type: 'slack', name: 'meta', url: 'https://169.254.169.254/latest', events: ['issue.created'] })).status).toBe(400);
    delete process.env.PLUGINS_ALLOW_PRIVATE_HOSTS;
    for (const url of ['https://10.0.0.5/hook', 'https://127.0.0.1/hook', 'https://localhost/hook', 'http://203.0.113.10/hook', 'https://user:pw@203.0.113.10/hook']) {
      expect((await call('POST', base, { type: 'slack', name: 'ssrf', url, events: ['issue.created'] })).status, url).toBe(400);
    }
    process.env.PLUGINS_ALLOW_PRIVATE_HOSTS = 'true';

    expect((await call('POST', base, { type: 'slack', name: 'x', url: SLACK, events: [] })).status).toBe(400);
    expect((await call('POST', base, { type: 'slack', name: 'x', url: SLACK, events: ['nope'] })).status).toBe(400);
    expect((await call('POST', base, { type: 'discord', name: 'x', url: SLACK, events: ['issue.created'] })).status).toBe(400);

    const s = await call('POST', base, { type: 'slack', name: 'Dev channel', url: SLACK, events: ['issue.created', 'issue.transitioned', 'comment.added', 'issue.assigned', 'sprint.started', 'release.published'] });
    expect(s.status).toBe(201);
    slack = await s.json();
    const t = await call('POST', base, { type: 'teams', name: 'Teams', url: TEAMS, events: ['issue.created'], settings: { teamsFormat: 'messagecard' } });
    teams = await t.json();
    expect(slack.url).toBe('https://203.0.113.10/…');
    expect(JSON.stringify(slack)).not.toContain('secrettoken');
    const [row] = await db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, slack.id));
    expect(row.urlEnc).not.toContain('secrettoken');
    const list = await (await call('GET', base)).json();
    expect(list.channels).toHaveLength(2);
    expect(list.events.map((e: any) => e.id)).toContain('release.published');
    expect(JSON.stringify(list)).not.toContain('secrettoken');

    // updating to a forbidden URL is refused too
    expect((await call('PUT', `${base}/${slack.id}`, { url: 'https://169.254.169.254/x' })).status).toBe(400);
    // channels of another scope are invisible
    expect((await call('PUT', `/rest/api/2/admin/notification-channels/${slack.id}`, { name: 'hijack' })).status).toBe(404);
  });

  test('issue events are delivered to Slack and Teams in their own formats (injected fetch)', async () => {
    setNotifyFetch((async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('ok', { status: respond(calls.length) }); }) as any);
    const created = await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Chat <!here> me', priority: { id: seeded.priority.id } } });
    expect(created.status).toBe(201);
    const { key } = await created.json();
    await flushChatNotifications();
    const toSlack = calls.find((c) => c.url === SLACK && JSON.stringify(c.body).includes(key));
    const toTeams = calls.find((c) => c.url === TEAMS);
    expect(toSlack).toBeTruthy();
    expect(toSlack!.body.blocks[0].type).toBe('header');
    expect(JSON.stringify(toSlack!.body)).not.toContain('<!here>');
    expect(toTeams!.body['@type']).toBe('MessageCard');
    // the shared transport does not sign third-party deliveries
    const deliveries = await (await call('GET', `/rest/api/2/project/TEST/notification-channels/${slack.id}/deliveries`)).json();
    expect(deliveries[0]).toMatchObject({ event: 'issue.created', status: 'success', responseStatus: 200 });
  });

  test('only subscribed events are delivered; comments, assignment, sprint and release map to chat events', async () => {
    calls.length = 0;
    await deliverWebhook('issue.updated', { issueKey: 'TEST-1', summary: 's', projectId: seeded.project.id, projectName: 'Test' }); // plain update: not a chat event
    await deliverWebhook('sprint.closed', { sprintName: 'S1', projectId: seeded.project.id }); // not subscribed
    await flushChatNotifications();
    expect(calls).toHaveLength(0);

    await deliverWebhook('issue.updated', { issueKey: 'TEST-1', summary: 's', projectId: seeded.project.id, assignedTo: 5, assignerName: 'Ann' });
    await deliverWebhook('sprint.started', { sprintName: 'Sprint 7', goal: 'Ship it', projectId: seeded.project.id, sprintUrl: 'https://x.test/b/1' });
    await deliverWebhook('release.published', { versionName: '1.2.0', projectId: seeded.project.id });
    await flushChatNotifications();
    const texts = calls.filter((c) => c.url === SLACK).map((c) => c.body.text as string);
    expect(texts.some((t) => t.startsWith('Issue assigned'))).toBe(true);
    expect(texts.some((t) => t.includes('Sprint started: Sprint 7'))).toBe(true);
    expect(texts.some((t) => t.includes('Release published: 1.2.0'))).toBe(true);
    expect(calls.filter((c) => c.url === TEAMS)).toHaveLength(0); // Teams only wanted issue.created
  });

  test('the release endpoint publishes a release event once', async () => {
    calls.length = 0;
    const v = await (await call('POST', '/rest/api/2/project/TEST/versions', { name: '2.0.0' })).json();
    await flushChatNotifications();
    expect(calls).toHaveLength(0);
    expect((await call('PUT', `/rest/api/2/project/TEST/versions/${v.id}`, { released: true })).status).toBe(200);
    await flushChatNotifications();
    expect(calls.filter((c) => c.url === SLACK && c.body.text.includes('Release published: 2.0.0'))).toHaveLength(1);
    await call('PUT', `/rest/api/2/project/TEST/versions/${v.id}`, { released: true, description: 'again' });
    await flushChatNotifications();
    expect(calls.filter((c) => c.body.text?.includes('2.0.0'))).toHaveLength(1);
  });

  test('internal comments are never forwarded', async () => {
    calls.length = 0;
    const [issue] = await db.select().from(schema.issues).limit(1);
    const [cm] = await db.insert(schema.comments).values({ issueId: issue.id, body: 'secret internal note', authorId: seeded.user.id, isInternal: true }).returning();
    await deliverWebhook('comment.added', { issueKey: issue.issueKey, summary: 's', projectId: seeded.project.id, commentId: cm.id, commentBody: 'secret internal note' });
    const [pub] = await db.insert(schema.comments).values({ issueId: issue.id, body: 'public note', authorId: seeded.user.id, isInternal: false }).returning();
    await deliverWebhook('comment.added', { issueKey: issue.issueKey, summary: 's', projectId: seeded.project.id, commentId: pub.id, commentBody: 'public note' });
    await flushChatNotifications();
    const all = JSON.stringify(calls);
    expect(all).not.toContain('secret internal note');
    expect(all).toContain('public note');
  });

  test('retries on 5xx with back-off, then succeeds; a permanent 4xx is not retried and is logged', async () => {
    calls.length = 0;
    respond = (n) => (n === 1 ? 503 : 200);
    let r = await call('POST', `/rest/api/2/project/TEST/notification-channels/${slack.id}/test`);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect((await r.json()).attempts).toBe(2);

    calls.length = 0;
    respond = () => 404;
    r = await call('POST', `/rest/api/2/project/TEST/notification-channels/${slack.id}/test`);
    expect(r.status).toBe(502);
    expect(calls).toHaveLength(1);
    const log = await (await call('GET', `/rest/api/2/project/TEST/notification-channels/${slack.id}/deliveries`)).json();
    expect(log[0]).toMatchObject({ event: 'test', status: 'failed', responseStatus: 404 });
    respond = () => 200;
  });

  test('delivery time re-checks the URL (SSRF guard) and per-channel rate limit drops floods', async () => {
    // A channel whose stored URL became forbidden (e.g. DNS change / config change) is refused at send time.
    const { encryptSecret } = await import('../../src/auth/secrets');
    const [bad] = await db.insert(schema.notificationChannels).values({ projectId: seeded.project.id, type: 'slack', name: 'late', urlEnc: encryptSecret('https://169.254.169.254/x'), events: ['issue.created'] }).returning();
    calls.length = 0;
    let r = await call('POST', `/rest/api/2/project/TEST/notification-channels/${bad.id}/test`);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain('not allowed');
    expect(calls).toHaveLength(0);

    const fresh = await (await call('POST', '/rest/api/2/project/TEST/notification-channels', { type: 'teams', name: 'Flood', url: 'https://203.0.113.13/flood', events: ['issue.created'] })).json();
    process.env.NOTIFY_RATE_PER_MINUTE = '2';
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await call('POST', `/rest/api/2/project/TEST/notification-channels/${fresh.id}/test`)).status);
    delete process.env.NOTIFY_RATE_PER_MINUTE;
    expect(codes).toEqual([200, 200, 502, 502]);
    const log = await (await call('GET', `/rest/api/2/project/TEST/notification-channels/${fresh.id}/deliveries`)).json();
    expect(log.filter((d: any) => d.status === 'rate_limited')).toHaveLength(2);
  });

  test('instance default channels receive events of every project and are SYSTEM_ADMIN only', async () => {
    const base = '/rest/api/2/admin/notification-channels';
    expect((await call('GET', base, undefined, bobCookie)).status).toBe(403);
    const made = await call('POST', base, { type: 'teams', name: 'Everything', url: 'https://203.0.113.12/all', events: ['issue.created'] });
    expect(made.status).toBe(201);
    const inst = await made.json();
    expect(inst.projectId).toBeNull();
    const list = await (await call('GET', base)).json();
    expect(list.channels.map((c: any) => c.id)).toEqual([inst.id]); // project channels are not listed here
    calls.length = 0;
    await deliverWebhook('issue.created', { issueKey: 'TEST-99', summary: 'Hello', projectId: seeded.project.id, projectName: 'Test' });
    await flushChatNotifications();
    expect(calls.some((c) => c.url === 'https://203.0.113.12/all')).toBe(true);
    // a project that switched the feature off is silent, instance channels included
    await call('PUT', '/rest/api/2/project/TEST/features', { features: { integrations: false } });
    invalidateProjectFeatures();
    calls.length = 0;
    await deliverWebhook('issue.created', { issueKey: 'TEST-100', summary: 'Hello', projectId: seeded.project.id });
    await flushChatNotifications();
    expect(calls).toHaveLength(0);
    await call('PUT', '/rest/api/2/project/TEST/features', { features: { integrations: true } });
    invalidateProjectFeatures();
    expect((await call('DELETE', `${base}/${inst.id}`)).status).toBe(200);
  });

  test('channels can be disabled, edited and deleted', async () => {
    const base = '/rest/api/2/project/TEST/notification-channels';
    expect((await call('PUT', `${base}/${teams.id}`, { enabled: false, events: ['comment.added'] })).status).toBe(200);
    calls.length = 0;
    await deliverWebhook('issue.created', { issueKey: 'TEST-5', summary: 'x', projectId: seeded.project.id });
    await flushChatNotifications();
    expect(calls.some((c) => c.url === TEAMS)).toBe(false);
    expect((await call('DELETE', `${base}/${teams.id}`)).status).toBe(200);
    expect((await call('DELETE', `${base}/${teams.id}`)).status).toBe(404);
    expect((await call('DELETE', `${base}/${slack.id}`)).status).toBe(200);
  });
});
