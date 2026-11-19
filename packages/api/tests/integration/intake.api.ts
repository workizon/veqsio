import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateFeatures, setFeatureEnabled } from '../../src/features';
import { wakeSnoozed } from '../../src/intake/service';

const JSON_H = { 'Content-Type': 'application/json' };
const P = '/rest/api/2/project/TEST/intake';

describe('Intake / triage', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin = '', alice = '', bob = '', carol = '';
  let aliceId = 0;
  let slug = '';
  let ipCounter = 0;

  const call = (cookie: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(body !== undefined ? JSON_H : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0];
  const login = async (username: string) => cookieOf(await call(null, 'POST', '/rest/auth/1/session', { username, password: 'pw-123456' }));
  /** Every anonymous request comes from its own address unless a test wants to share one. */
  const freshIp = () => ({ 'X-Forwarded-For': `10.0.0.1, 203.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}` });
  const submitPublic = (body: unknown, headers: Record<string, string> = freshIp(), s = slug) => call(null, 'POST', `/rest/public/intake/${s}`, body, headers);
  const submitApp = async (cookie: string, title: string, extra: Record<string, unknown> = {}) => {
    const res = await call(cookie, 'POST', `${P}/items`, { title, ...extra });
    expect(res.status).toBe(201);
    return res.json();
  };
  const queued = async () => db.select().from(schema.emailQueue).orderBy(schema.emailQueue.id);

  beforeAll(async () => {
    process.env.RATE_LIMIT_IP_MAX = '10000000';
    process.env.RATE_LIMIT_USER_MAX = '10000000';
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = async (username: string) => (await db.insert(schema.users).values({ username, email: `${username}@example.com`, displayName: username[0].toUpperCase() + username.slice(1), passwordHash: hash }).returning())[0];
    const a = await mk('alice'); const b = await mk('bob'); await mk('carol');
    aliceId = a.id;
    // alice: developer (triages), bob: can only browse. carol: nothing.
    await db.insert(schema.permissionEntries).values([
      ...['BROWSE_PROJECTS', 'CREATE_ISSUES', 'ASSIGNABLE_USER'].map((p) => ({ schemeId: seeded.permScheme.id, permissionKey: p, userId: a.id })),
      { schemeId: seeded.permScheme.id, permissionKey: 'BROWSE_PROJECTS', userId: b.id },
    ]);
    admin = await login('admin'); alice = await login('alice'); bob = await login('bob'); carol = await login('carol');
  });
  afterAll(async () => { invalidateFeatures(); await resetTestDb(testSql); await testSql.end(); });

  test('intake is off by default and only project admins can turn it on', async () => {
    expect((await call(alice, 'GET', `${P}/info`)).status).toBe(200);
    expect(await (await call(alice, 'GET', `${P}/info`)).json()).toMatchObject({ enabled: false, canTriage: true, canAdmin: false });
    expect((await call(alice, 'POST', `${P}/items`, { title: 'x' })).status).toBe(404); // disabled
    expect((await call(alice, 'GET', `${P}/items`)).status).toBe(404);
    expect((await call(alice, 'PUT', `${P}/settings`, { enabled: true })).status).toBe(403);
    expect((await call(alice, 'GET', `${P}/settings`)).status).toBe(403);
    expect((await call(carol, 'GET', `${P}/info`)).status).toBe(404); // cannot even see the project
    const res = await call(admin, 'PUT', `${P}/settings`, { enabled: true, publicFormEnabled: true, formTitle: 'Tell us', formIntro: 'We read everything.', fields: { name: 'optional', email: 'required', description: 'optional' } });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s).toMatchObject({ enabled: true, publicFormEnabled: true, formTitle: 'Tell us', fields: { email: 'required' } });
    expect(s.slug.length).toBeGreaterThanOrEqual(16);
    expect(s.publicFormPath).toBe(`/intake/${s.slug}`);
    slug = s.slug;
    expect((await call(admin, 'PUT', `${P}/settings`, { enabled: true, bogus: 1 })).status).toBe(400); // strict
    expect((await call(admin, 'PUT', `${P}/settings`, { emailEnabled: true })).status).toBe(400); // no secret yet
  });

  test('service desk projects cannot enable intake', async () => {
    const [p] = await db.insert(schema.projects).values({ projectKey: 'DESK', name: 'Desk', leadId: seeded.user.id }).returning();
    await db.insert(schema.serviceDesks).values({ projectId: p.id, name: 'Desk', slug: 'desk-x' });
    const res = await call(admin, 'PUT', '/rest/api/2/project/DESK/intake/settings', { enabled: true });
    expect(res.status).toBe(400);
  });

  test('members submit in the app; viewing the queue needs the triage permission', async () => {
    const item = await submitApp(bob, 'Dark mode please', { description: 'It hurts my eyes' });
    expect(item).toMatchObject({ status: 'pending', source: 'app', title: 'Dark mode please', requester: { name: 'Bob', email: 'bob@example.com' } });
    expect((await call(bob, 'GET', `${P}/items`)).status).toBe(403);
    expect((await call(bob, 'GET', `${P}/items/${item.id}`)).status).toBe(403);
    expect((await call(bob, 'POST', `${P}/items/${item.id}/decline`, {})).status).toBe(403);
    expect((await call(carol, 'POST', `${P}/items`, { title: 'x' })).status).toBe(404);
    expect((await call(bob, 'POST', `${P}/items`, { title: '' })).status).toBe(400);
    expect((await call(bob, 'POST', `${P}/items`, { title: 'x', status: 'accepted' })).status).toBe(400); // no mass assignment
    const list = await (await call(alice, 'GET', `${P}/items?status=pending`)).json();
    expect(list.counts.pending).toBe(1);
    expect(list.items[0].title).toBe('Dark mode please');
    expect((await call(alice, 'GET', `${P}/items?status=nonsense`)).status).toBe(400);
  });

  test('accepting creates a real issue, links the item and emails the requester', async () => {
    const item = await submitApp(alice, 'Login button is broken', { description: 'Clicking does nothing', requesterName: 'Dana <b>', requesterEmail: 'dana@example.org' });
    const before = (await queued()).length;
    expect((await call(alice, 'POST', `${P}/items/${item.id}/accept`, {})).status).toBe(400); // type required
    expect((await call(alice, 'POST', `${P}/items/${item.id}/accept`, { issueTypeId: 99999 })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/accept`, { issueTypeId: seeded.issueType.id, assigneeId: seeded.user.id + 999 })).status).toBe(400);
    const res = await call(alice, 'POST', `${P}/items/${item.id}/accept`, { issueTypeId: seeded.issueType.id, priorityId: seeded.priority.id, assigneeId: aliceId, reason: 'Thanks, on it' });
    expect(res.status).toBe(200);
    const done = await res.json();
    expect(done.status).toBe('accepted');
    expect(done.acceptedIssue.key).toMatch(/^TEST-\d+$/);
    const issue = await (await call(alice, 'GET', `/rest/api/2/issue/${done.acceptedIssue.key}`)).json();
    expect(issue.fields.summary).toBe('Login button is broken');
    expect(issue.fields.assignee.displayName).toBe('Alice');
    expect(issue.fields.description).toContain('Clicking does nothing');
    expect(issue.fields.description).toContain('Submitted via intake');
    // a second decision is refused
    expect((await call(alice, 'POST', `${P}/items/${item.id}/decline`, {})).status).toBe(409);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/accept`, { issueTypeId: seeded.issueType.id })).status).toBe(409);
    const mails = (await queued()).slice(before).filter((m) => m.toAddress === 'dana@example.org');
    expect(mails.length).toBe(1);
    expect(mails[0].toAddress).toBe('dana@example.org');
    expect(mails[0].subject).toContain('accepted');
    expect(mails[0].htmlBody).toContain(done.acceptedIssue.key);
    // the item shows up under Accepted and is not an issue before that
    const accepted = await (await call(alice, 'GET', `${P}/items?status=accepted`)).json();
    expect(accepted.items.map((i: any) => i.id)).toContain(item.id);
  });

  test('requester emails escape user-controlled data', async () => {
    const evil = '<script>alert(1)</script>';
    const item = await submitApp(alice, `Bad ${evil}`, { requesterName: `"><img src=x onerror=alert(2)>`, requesterEmail: 'evil@example.org' });
    const before = (await queued()).length;
    const res = await call(alice, 'POST', `${P}/items/${item.id}/decline`, { reason: `no ${evil}` });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('declined');
    const mail = (await queued()).slice(before)[0];
    expect(mail.toAddress).toBe('evil@example.org');
    expect(mail.subject).toContain('declined');
    expect(mail.htmlBody).not.toContain('<script>alert(1)</script>');
    expect(mail.htmlBody).not.toContain('<img src=x');
    expect(mail.htmlBody).toContain('&lt;script&gt;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  test('items without a requester email send no mail', async () => {
    const item = await (await call(alice, 'POST', `${P}/items`, { title: 'Anonymous idea', requesterEmail: '' })).json();
    // the app falls back to the submitting user's email when none is given: clear it to simulate an unknown requester
    await db.update(schema.intakeItems).set({ requesterEmail: null }).where(eq(schema.intakeItems.id, item.id));
    const before = (await queued()).length;
    expect((await call(alice, 'POST', `${P}/items/${item.id}/decline`, {})).status).toBe(200);
    expect((await queued()).length).toBe(before);
  });

  test('duplicate links an existing issue of the same project and reopen puts it back', async () => {
    const item = await submitApp(alice, 'Same as before');
    const key = (await (await call(alice, 'GET', `${P}/items?status=accepted`)).json()).items[0].acceptedIssue.key;
    expect((await call(alice, 'POST', `${P}/items/${item.id}/duplicate`, { issue: 'nonsense' })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/duplicate`, { issue: 'TEST-99999' })).status).toBe(400);
    const res = await call(alice, 'POST', `${P}/items/${item.id}/duplicate`, { issue: key.toLowerCase(), reason: 'dup' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'duplicate', duplicateOf: { key } });
    const reopened = await (await call(alice, 'POST', `${P}/items/${item.id}/reopen`, {})).json();
    expect(reopened).toMatchObject({ status: 'pending', duplicateOf: null, decisionReason: null });
  });

  test('duplicate rejects issues of other projects', async () => {
    const [other] = await db.insert(schema.projects).values({ projectKey: 'ELSE', name: 'Else', leadId: seeded.user.id }).returning();
    const [iss] = await db.insert(schema.issues).values({ issueKey: 'ELSE-1', projectId: other.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'secret', reporterId: seeded.user.id }).returning();
    const item = await submitApp(alice, 'Cross project');
    const res = await call(alice, 'POST', `${P}/items/${item.id}/duplicate`, { issue: iss.issueKey });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('secret');
  });

  test('snooze hides an item until its date, then it is pending again', async () => {
    const item = await submitApp(alice, 'Maybe later');
    expect((await call(alice, 'POST', `${P}/items/${item.id}/snooze`, {})).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/snooze`, { until: 'yesterday' })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/items/${item.id}/snooze`, { until: new Date(Date.now() + 5 * 365 * 86400000).toISOString() })).status).toBe(400);
    const until = new Date(Date.now() + 3 * 86400000).toISOString();
    const res = await call(alice, 'POST', `${P}/items/${item.id}/snooze`, { until });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('snoozed');
    const pending = await (await call(alice, 'GET', `${P}/items?status=pending`)).json();
    expect(pending.items.map((i: any) => i.id)).not.toContain(item.id);
    expect((await (await call(alice, 'GET', `${P}/items?status=snoozed`)).json()).items.map((i: any) => i.id)).toContain(item.id);
    // not due yet: nothing happens
    expect(await wakeSnoozed(seeded.project.id)).toBe(0);
    // time passes
    await db.update(schema.intakeItems).set({ snoozedUntil: new Date(Date.now() - 60_000) }).where(eq(schema.intakeItems.id, item.id));
    const back = await (await call(alice, 'GET', `${P}/items?status=pending`)).json(); // reads wake due items
    expect(back.items.map((i: any) => i.id)).toContain(item.id);
    const row = (await call(alice, 'GET', `${P}/items/${item.id}`));
    expect(await row.json()).toMatchObject({ status: 'pending', snoozedUntil: null });
    // the periodic job does the same for items nobody has looked at
    await call(alice, 'POST', `${P}/items/${item.id}/snooze`, { until });
    await db.update(schema.intakeItems).set({ snoozedUntil: new Date(Date.now() - 1000) }).where(eq(schema.intakeItems.id, item.id));
    expect(await wakeSnoozed()).toBe(1);
    expect((await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, item.id)))[0].status).toBe('pending');
  });

  test('bulk actions report per item, cap the batch and stay inside the project', async () => {
    const a = await submitApp(alice, 'Bulk A'); const b = await submitApp(alice, 'Bulk B'); const c = await submitApp(alice, 'Bulk C');
    await call(alice, 'POST', `${P}/items/${c.id}/decline`, {});
    const res = await call(alice, 'POST', `${P}/bulk`, { ids: [a.id, b.id, c.id, 987654], action: 'decline', reason: 'out of scope' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(2);
    expect(body.results.find((r: any) => r.id === 987654).ok).toBe(false);
    expect(body.results.find((r: any) => r.id === c.id).error).toContain('declined');
    const d = await submitApp(alice, 'Bulk D'); const e = await submitApp(alice, 'Bulk E');
    const acc = await (await call(alice, 'POST', `${P}/bulk`, { ids: [d.id, e.id], action: 'accept', issueTypeId: seeded.issueType.id })).json();
    expect(acc.succeeded).toBe(2);
    expect((await call(alice, 'POST', `${P}/bulk`, { ids: Array.from({ length: 101 }, (_, i) => i + 1), action: 'decline' })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/bulk`, { ids: [], action: 'decline' })).status).toBe(400);
    expect((await call(alice, 'POST', `${P}/bulk`, { ids: [1], action: 'delete' })).status).toBe(400);
    expect((await call(bob, 'POST', `${P}/bulk`, { ids: [a.id], action: 'decline' })).status).toBe(403);
    expect((await call(alice, 'POST', `${P}/bulk`, { ids: [1], action: 'snooze' })).status).toBe(400); // until missing
  });

  test('items of another project are not reachable through this one', async () => {
    const [other] = await db.insert(schema.projects).values({ projectKey: 'ISO', name: 'Iso', leadId: seeded.user.id }).returning();
    const [row] = await db.insert(schema.intakeItems).values({ projectId: other.id, title: 'foreign', source: 'api' }).returning();
    expect((await call(alice, 'GET', `${P}/items/${row.id}`)).status).toBe(404);
    expect((await call(alice, 'POST', `${P}/items/${row.id}/decline`, {})).status).toBe(404);
  });

  test('a token is an API client and its submissions are marked api', async () => {
    const tok = await (await call(admin, 'POST', '/rest/api/2/mypersonalaccessTokens', { name: 'intake', scopes: ['write:projects'] })).json();
    expect(tok.token).toBeTruthy();
    const res = await call(null, 'POST', `${P}/items`, { title: 'From CI' }, { Authorization: `Bearer ${tok.token}` });
    expect(res.status).toBe(201);
    expect((await res.json()).source).toBe('api');
  });

  test('public form: shows only title, intro and fields; the slug is unguessable', async () => {
    const res = await call(null, 'GET', `/rest/public/intake/${slug}`);
    expect(res.status).toBe(200);
    const def = await res.json();
    expect(def).toEqual({ title: 'Tell us', intro: 'We read everything.', fields: { name: 'optional', email: 'required', description: 'optional' } });
    const text = JSON.stringify(def);
    expect(text).not.toContain('Test Project');
    expect(text).not.toContain('TEST');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await call(null, 'GET', '/rest/public/intake/short')).status).toBe(404);
    expect((await call(null, 'GET', `/rest/public/intake/${'a'.repeat(24)}`)).status).toBe(404);
    expect((await call(null, 'GET', '/rest/public/intake/TEST')).status).toBe(404); // the project key is not an address
  });

  test('public form: submissions land in the queue as pending form items, never as issues', async () => {
    const issuesBefore = (await db.select().from(schema.issues)).length;
    expect((await submitPublic({ title: 'Hello', email: 'not-an-email' })).status).toBe(400);
    expect((await submitPublic({ title: 'Hello' })).status).toBe(400); // email required by this form
    expect((await submitPublic({ title: '', email: 'a@b.co' })).status).toBe(400);
    expect((await submitPublic({ title: 'x', email: 'a@b.co', status: 'accepted' })).status).toBe(400); // strict
    expect((await submitPublic('not json')).status).toBe(400);
    const res = await submitPublic({ title: 'Public idea', description: 'Please add X', name: 'Pat', email: 'Pat@Example.com' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'received' }); // no ids come back
    const [row] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.title, 'Public idea'));
    expect(row).toMatchObject({ source: 'form', status: 'pending', requesterEmail: 'pat@example.com', requesterName: 'Pat', requesterUserId: null });
    expect((await db.select().from(schema.issues)).length).toBe(issuesBefore);
  });

  test('public form: fields switched off are not stored', async () => {
    await call(admin, 'PUT', `${P}/settings`, { fields: { name: 'off', email: 'optional', description: 'off' } });
    expect((await submitPublic({ title: 'Minimal', name: 'Sneaky', description: 'sneaky' })).status).toBe(201);
    const [row] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.title, 'Minimal'));
    expect(row.requesterName).toBeNull();
    expect(row.description).toBe('');
    await call(admin, 'PUT', `${P}/settings`, { fields: { name: 'optional', email: 'required', description: 'optional' } });
  });

  test('public form: honeypot looks like success but stores nothing', async () => {
    const before = (await db.select().from(schema.intakeItems)).length;
    const res = await submitPublic({ title: 'Buy cheap pills', email: 'bot@spam.example', website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'received' });
    expect((await db.select().from(schema.intakeItems)).length).toBe(before);
  });

  test('public form: oversized bodies and fields are refused', async () => {
    const big = JSON.stringify({ title: 'x', email: 'a@b.co', description: 'y'.repeat(25_000) });
    expect((await submitPublic(big)).status).toBe(413);
    expect((await submitPublic(big, { ...freshIp(), 'Content-Length': String(big.length) })).status).toBe(413);
    const long = await submitPublic({ title: 't'.repeat(300), email: 'a@b.co' });
    expect(long.status).toBe(400);
    const desc = await submitPublic({ title: 'ok', email: 'a@b.co', description: 'd'.repeat(10_500) });
    expect(desc.status).toBe(400);
  });

  test('public form: per-IP limit answers 429 with Retry-After, other addresses are unaffected', async () => {
    const ip = { 'X-Forwarded-For': '198.51.100.7' };
    let last: Response | null = null;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) { last = await submitPublic({ title: `Burst ${i}`, email: 'a@b.co' }, ip); statuses.push(last.status); }
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(last!.headers.get('retry-after')).toBeTruthy();
    expect((await submitPublic({ title: 'Other visitor', email: 'a@b.co' })).status).toBe(201);
    // probing slugs spends the same budget
    expect((await submitPublic({ title: 'x' }, ip, 'z'.repeat(24))).status).toBe(429);
  });

  test('public form: a per-form hourly cap protects against distributed floods', async () => {
    process.env.INTAKE_PUBLIC_SLUG_MAX = '3';
    try {
      const { redis } = await import('../../src/services/cache');
      const [s] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.slug, slug));
      await redis.del(`veqsio:ratelimit:intake-public-slug:${s.id}`);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await submitPublic({ title: `Flood ${i}`, email: 'a@b.co' })).status);
      expect(codes).toEqual([201, 201, 201, 429, 429]);
    } finally { delete process.env.INTAKE_PUBLIC_SLUG_MAX; }
  });

  test('public form: closed when disabled, and a rotated slug stops working at once', async () => {
    await call(admin, 'PUT', `${P}/settings`, { publicFormEnabled: false });
    expect((await call(null, 'GET', `/rest/public/intake/${slug}`)).status).toBe(404);
    expect((await submitPublic({ title: 'x', email: 'a@b.co' })).status).toBe(404);
    await call(admin, 'PUT', `${P}/settings`, { publicFormEnabled: true });
    expect((await call(null, 'GET', `/rest/public/intake/${slug}`)).status).toBe(200);
    expect((await call(alice, 'POST', `${P}/settings/rotate-slug`)).status).toBe(403);
    const rotated = await (await call(admin, 'POST', `${P}/settings/rotate-slug`)).json();
    expect(rotated.slug).not.toBe(slug);
    expect((await call(null, 'GET', `/rest/public/intake/${slug}`)).status).toBe(404);
    expect((await call(null, 'GET', `/rest/public/intake/${rotated.slug}`)).status).toBe(200);
    slug = rotated.slug;
  });

  test('email webhook: secret required, creates items, is idempotent, ignores auto-replies and escapes nothing into html', async () => {
    const hook = (body: unknown, secret?: string, s = slug) => call(null, 'POST', `/rest/api/2/intake/${s}/email`, body, secret ? { 'X-Veqsio-Inbound-Secret': secret } : {});
    const msg = { messageId: '<m1@mail>', from: 'Erin <erin@example.net>', subject: 'Re: Please add <b>export</b>', text: 'Hello\n\n> quoted\n\nOn Mon, Erin wrote:\n> old' };
    expect((await hook(msg)).status).toBe(404); // email intake not enabled
    expect((await call(alice, 'POST', `${P}/settings/rotate-email-secret`)).status).toBe(403);
    const { secret } = await (await call(admin, 'POST', `${P}/settings/rotate-email-secret`)).json();
    expect(secret.length).toBeGreaterThan(30);
    expect((await call(admin, 'GET', `${P}/settings`).then((r) => r.json())).emailConfigured).toBe(true);
    expect(JSON.stringify(await (await call(admin, 'GET', `${P}/settings`)).json())).not.toContain(secret);
    expect((await call(admin, 'PUT', `${P}/settings`, { emailEnabled: true })).status).toBe(200);
    expect((await hook(msg)).status).toBe(401);
    expect((await hook(msg, 'wrong')).status).toBe(401);
    const ok = await hook(msg, secret);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ status: 'created' });
    const [row] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.sourceRef, '<m1@mail>'));
    expect(row).toMatchObject({ source: 'email', status: 'pending', requesterEmail: 'erin@example.net', requesterName: 'Erin' });
    expect(row.title).toBe('Please add <b>export</b>'); // stored as plain text; output is escaped when rendered
    expect(row.description).toBe('Hello');
    expect(await (await hook(msg, secret)).json()).toEqual({ status: 'duplicate' });
    expect(await (await hook({ ...msg, messageId: '<m2@mail>', headers: { 'Auto-Submitted': 'auto-replied' } }, secret)).json()).toEqual({ status: 'rejected' });
    expect((await hook({ ...msg, messageId: '<m3@mail>', from: 'nope' }, secret)).status).toBe(400);
    expect((await hook({ ...msg, extra: 1 }, secret)).status).toBe(400);
    expect((await hook({ ...msg, text: 'x'.repeat(310_000) }, secret)).status).toBe(413);
    expect((await hook(msg, secret, 'q'.repeat(24))).status).toBe(404);
    // the requester of an email item is told about the decision, with escaped data
    const before = (await queued()).length;
    await call(alice, 'POST', `${P}/items/${row.id}/decline`, { reason: 'later' });
    const mail = (await queued()).slice(before)[0];
    expect(mail.toAddress).toBe('erin@example.net');
    expect(mail.htmlBody).toContain('&lt;b&gt;export&lt;/b&gt;');
    expect(mail.htmlBody).not.toContain('<b>export</b>');
  });

  test('the feature switch closes every intake route', async () => {
    await setFeatureEnabled('intake', false);
    try {
      expect((await call(alice, 'GET', `${P}/items`)).status).toBe(404);
      expect((await call(admin, 'GET', `${P}/settings`)).status).toBe(404);
      expect((await call(null, 'GET', `/rest/public/intake/${slug}`)).status).toBe(404);
      expect((await submitPublic({ title: 'x', email: 'a@b.co' })).status).toBe(404);
      expect((await call(null, 'POST', `/rest/api/2/intake/${slug}/email`, {})).status).toBe(404);
    } finally { await setFeatureEnabled('intake', true); }
    expect((await call(alice, 'GET', `${P}/items`)).status).toBe(200);
    const features = await (await call(alice, 'GET', '/rest/api/2/features')).json();
    expect(features.features.find((f: any) => f.id === 'intake').enabled).toBe(true);
  });

  test('disabling intake keeps the data and hides the queue', async () => {
    const count = (await db.select().from(schema.intakeItems)).length;
    await call(admin, 'PUT', `${P}/settings`, { enabled: false });
    expect((await call(alice, 'GET', `${P}/items`)).status).toBe(404);
    expect((await call(null, 'GET', `/rest/public/intake/${slug}`)).status).toBe(404);
    expect((await db.select().from(schema.intakeItems)).length).toBe(count);
    await call(admin, 'PUT', `${P}/settings`, { enabled: true });
    expect((await call(alice, 'GET', `${P}/items`)).status).toBe(200);
  });

  test('accepting is atomic: concurrent decisions on one item produce one issue', async () => {
    const item = await submitApp(alice, 'Race me');
    const issuesBefore = (await db.select().from(schema.issues)).length;
    const results = await Promise.all([1, 2, 3].map(() => call(alice, 'POST', `${P}/items/${item.id}/accept`, { issueTypeId: seeded.issueType.id })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await db.select().from(schema.issues)).length).toBe(issuesBefore + 1);
    const [row] = await db.select().from(schema.intakeItems).where(and(eq(schema.intakeItems.id, item.id)));
    expect(row.acceptedIssueId).not.toBeNull();
  });

  test('the project lead is emailed about a new submission, at most once per 10 minutes, and can opt out', async () => {
    const { getRedisClient } = await import('../../src/services/redis-client');
    const redis = getRedisClient();
    const [lead] = await db.select().from(schema.users).where(eq(schema.users.id, seeded.user.id));
    await db.update(schema.projects).set({ leadId: lead.id }).where(eq(schema.projects.id, seeded.project.id));
    await redis.del(`veqsio:intake:notified:${seeded.project.id}`);
    const leadMails = async (since: number) => (await queued()).slice(since).filter((m) => m.toAddress === lead.email && m.subject.startsWith('New intake submission'));
    const before = (await queued()).length;
    await submitApp(alice, 'Notify me one');
    await submitApp(alice, 'Notify me two');
    await new Promise((r) => setTimeout(r, 300));
    const mails = await leadMails(before);
    expect(mails.length).toBe(1);
    expect(mails[0].htmlBody).toContain('/projects/TEST/intake');
    // opt out
    expect((await call(admin, 'PUT', `${P}/settings`, { notifyLead: false })).status).toBe(200);
    await redis.del(`veqsio:intake:notified:${seeded.project.id}`);
    const before2 = (await queued()).length;
    await submitApp(alice, 'Quiet one');
    await new Promise((r) => setTimeout(r, 300));
    expect((await leadMails(before2)).length).toBe(0);
  });
});
