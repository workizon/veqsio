import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import app from '../../src/app';

describe('Service Desk email channel', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin: string, alice: string;
  let deskId: number;
  let rtId: number;
  let secret: string;
  let seq = 0;
  let firstKey: string;

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  const inbound = (payload: Record<string, unknown>, sec: string | null = secret, slug = 'mail-desk') =>
    app.request(`/rest/servicedeskapi/inbound-email/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sec === null ? {} : { 'X-Veqsio-Inbound-Secret': sec }) },
      body: JSON.stringify({ messageId: `<m${++seq}@mail.test>`, subject: 'Hello', text: 'body', ...payload }),
    });

  const publicComments = async (key: string) => {
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    return db.select().from(schema.comments).where(eq(schema.comments.issueId, issue.id));
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values([
      { username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash },
      { username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash },
    ]);
    admin = await login('admin');
    alice = await login('alice');
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('setup: desk, request type, channel creation reveals secret once', async () => {
    let res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Mail', slug: 'mail-desk' });
    expect(res.status).toBe(201);
    deskId = (await res.json()).id;
    res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`, {
      name: 'General', issueTypeId: seeded.issueType.id, fields: [],
    });
    expect(res.status).toBe(201);
    rtId = (await res.json()).id;

    res = await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`);
    expect((await res.json()).configured).toBe(false);

    res = await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { enabled: false });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.secretHash).toBeUndefined();
    secret = body.secret;

    res = await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`);
    const view = await res.json();
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.secret).toBeUndefined();
    expect(view.secretHash).toBeUndefined();
    expect(view.enabled).toBe(false);
  });

  test('admin endpoints: non-members 404, strict body, foreign request type rejected', async () => {
    let res = await call(alice, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`);
    expect(res.status).toBe(404);
    res = await call(alice, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel/rotate-secret`);
    expect(res.status).toBe(404);
    res = await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { secretHash: 'x' });
    expect(res.status).toBe(400);
    res = await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { defaultRequestTypeId: 99999 });
    expect(res.status).toBe(400);
  });

  test('disabled channel and unknown slug return 404', async () => {
    expect((await inbound({ from: 'new@corp.com' })).status).toBe(404);
    expect((await inbound({ from: 'new@corp.com' }, secret, 'nope')).status).toBe(404);
  });

  test('missing or wrong secret is 401', async () => {
    await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { enabled: true });
    expect((await inbound({ from: 'new@corp.com' }, null)).status).toBe(401);
    expect((await inbound({ from: 'new@corp.com' }, 'wrong')).status).toBe(401);
    expect((await inbound({ from: 'new@corp.com' }, secret.toUpperCase())).status).toBe(401);
  });

  test('payload validation: unknown keys, bad sender, bad JSON', async () => {
    expect((await inbound({ from: 'new@corp.com', extra: 1 })).status).toBe(400);
    expect((await inbound({ from: 'not-an-address' })).status).toBe(400);
    const res = await app.request('/rest/servicedeskapi/inbound-email/mail-desk', {
      method: 'POST', headers: { 'X-Veqsio-Inbound-Secret': secret }, body: '{nope',
    });
    expect(res.status).toBe(400);
  });

  test('no default request type: rejected and recorded, nothing created', async () => {
    const res = await inbound({ messageId: '<norule@x>', from: 'new@corp.com' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('rejected');
    const [row] = await db.select().from(schema.sdInboundMessages).where(eq(schema.sdInboundMessages.messageId, '<norule@x>'));
    expect(row.status).toBe('rejected');
    expect(row.reason).toContain('request type');
    expect(await db.select().from(schema.serviceRequests)).toHaveLength(0);
  });

  test('unknown sender or non-customer is rejected when public signup is off, with identical responses', async () => {
    await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { defaultRequestTypeId: rtId });
    const r1 = await inbound({ from: 'stranger@corp.com' });
    const r2 = await inbound({ from: 'alice@example.com' }); // has an account, not a customer
    expect(await r1.json()).toEqual({ status: 'rejected' });
    expect(await r2.json()).toEqual({ status: 'rejected' });
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'stranger@corp.com'))).toHaveLength(0);
    expect(await db.select().from(schema.serviceRequests)).toHaveLength(0);
  });

  test('new sender creates a request (public signup), with placeholder customer user', async () => {
    await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}`, { publicSignup: true });
    const res = await inbound({
      from: 'Carol Customer <Carol@Corp.com>', subject: 'Re: Printer\r\n broken', text: 'The printer is on fire.\n\n-- \nCarol',
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.status).toBe('created');
    firstKey = out.key;
    expect(firstKey).toMatch(/^TEST-\d+$/);

    const [carol] = await db.select().from(schema.users).where(eq(schema.users.email, 'carol@corp.com'));
    expect(carol.passwordHash).toBeNull();
    expect(carol.active).toBe(true);
    expect(carol.displayName).toBe('Carol Customer');
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, firstKey));
    expect(issue.summary).toBe('Printer broken');
    expect(issue.description).toBe('The printer is on fire.');
    const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id));
    expect(sr.channel).toBe('email');
    expect(sr.customerId).toBe(carol.id);
    const cust = await db.select().from(schema.serviceDeskCustomers)
      .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, deskId), eq(schema.serviceDeskCustomers.userId, carol.id)));
    expect(cust).toHaveLength(1);
  });

  test('reply from the customer threads in as a public comment with quotes stripped', async () => {
    const res = await inbound({
      from: 'carol@corp.com',
      subject: `Re: [${firstKey}] Printer broken`,
      text: 'Thanks, now it is smoking.\n\nOn Mon, 3 Jun 2024 at 10:00, Support <help@x.com> wrote:\n> Did you try turning it off?\n> yes\n\n-- \nCarol',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('commented');
    const comments = await publicComments(firstKey);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('Thanks, now it is smoking.');
    expect(comments[0].isInternal).toBe(false);
    const [carol] = await db.select().from(schema.users).where(eq(schema.users.email, 'carol@corp.com'));
    expect(comments[0].authorId).toBe(carol.id);
  });

  test("a stranger referencing someone else's request key gets a NEW request, never a comment", async () => {
    const before = (await publicComments(firstKey)).length;
    const res = await inbound({ from: 'bob@example.com', subject: `Re: [${firstKey}] Printer broken`, text: 'I want in on this' });
    const out = await res.json();
    expect(out.status).toBe('created');
    expect(out.key).not.toBe(firstKey);
    expect(await publicComments(firstKey)).toHaveLength(before);
    expect(await publicComments(out.key)).toHaveLength(0);
  });

  test('participant can reply into the request; unknown address cannot', async () => {
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, firstKey));
    const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id));
    const [alice] = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com'));
    await db.insert(schema.requestParticipants).values({ requestId: sr.id, userId: alice.id });
    const before = (await publicComments(firstKey)).length;
    const res = await inbound({ from: 'alice@example.com', subject: `[${firstKey}] x`, text: 'me too' });
    expect((await res.json()).status).toBe('commented');
    expect(await publicComments(firstKey)).toHaveLength(before + 1);
  });

  test('duplicate message id is ignored', async () => {
    const payload = { messageId: '<dup@x>', from: 'dave@corp.com', subject: 'Dup' };
    expect((await (await inbound(payload)).json()).status).toBe('created');
    const again = await inbound(payload);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    const reqs = await db.select().from(schema.users).where(eq(schema.users.email, 'dave@corp.com'));
    expect(reqs).toHaveLength(1);
    const msgs = await db.select().from(schema.sdInboundMessages).where(eq(schema.sdInboundMessages.messageId, '<dup@x>'));
    expect(msgs).toHaveLength(1);
  });

  test('auto-replies and bulk mail are rejected', async () => {
    const countRequests = async () => (await db.select().from(schema.serviceRequests)).length;
    const n = await countRequests();
    for (const extra of [
      { headers: { 'Auto-Submitted': 'auto-replied' } },
      { headers: { Precedence: 'bulk' } },
      { headers: { 'X-Autoreply': 'yes' } },
      { subject: 'Out of office: back Monday' },
      { subject: 'Automatic reply: hello' },
    ]) {
      const res = await inbound({ from: 'eve@corp.com', ...extra });
      expect((await res.json()).status).toBe('rejected');
    }
    expect(await countRequests()).toBe(n);
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'eve@corp.com'))).toHaveLength(0);
  });

  test('sender domain allow-list is enforced', async () => {
    let res = await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { allowedSenderDomains: ['@Corp.com'] });
    expect((await res.json()).allowedSenderDomains).toEqual(['corp.com']);
    res = await inbound({ from: 'mallory@evil.com' });
    expect((await res.json()).status).toBe('rejected');
    res = await inbound({ from: 'frank@corp.com' });
    expect((await res.json()).status).toBe('created');
    await call(admin, 'PUT', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`, { allowedSenderDomains: [] });
  });

  test('rotate-secret returns a new secret once and invalidates the old one', async () => {
    const old = secret;
    const res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel/rotate-secret`);
    expect(res.status).toBe(200);
    secret = (await res.json()).secret;
    expect(secret).not.toBe(old);
    expect((await inbound({ from: 'gina@corp.com' }, old)).status).toBe(401);
    expect((await inbound({ from: 'gina@corp.com' }, secret)).status).toBe(201);
    const view = await (await call(admin, 'GET', `/rest/servicedeskapi/servicedesk/${deskId}/email-channel`)).json();
    expect(JSON.stringify(view)).not.toContain(secret);
  });
});
