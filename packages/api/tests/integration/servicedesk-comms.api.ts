import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and, desc } from 'drizzle-orm';
import app from '../../src/app';
import { processEmailQueue, setMailTransportForTests } from '../../src/services/email';
import { sendRequestMail, MAX_MAILS_PER_REQUEST_HOUR } from '../../src/servicedesk/outbound-mail';
import {
  setMailSourceFactoryForTests, pollDesk, pollDueDesks, type MailSource,
} from '../../src/servicedesk/imap-poller';

/**
 * Customer e-mail loop (reply mails, IMAP polling), requests raised on behalf of customers, merge and link.
 * Mail is captured from the e-mail queue and through an injected fake transport; the mailbox is a fake MailSource.
 */
describe('Service desk communication: mail loop, on behalf, merge', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let admin: string, alice: string, agent: string;
  let deskId: number, rtId: number;
  let aliceId: number, bobId: number;
  let key: string;
  const savedEnv: Record<string, string | undefined> = {};

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };
  const SD = '/rest/servicedeskapi/servicedesk';
  const mails = (to?: string) => db.select().from(schema.emailQueue).orderBy(schema.emailQueue.id)
    .then((rows) => (to ? rows.filter((r) => r.toAddress === to) : rows));
  const newRequest = async (cookie: string, summary: string) => {
    const res = await call(cookie, 'POST', '/rest/servicedeskapi/portal/comms-desk/request', { requestTypeId: rtId, summary });
    expect(res.status).toBe(201);
    return (await res.json()).key as string;
  };
  const issueId = async (k: string) => (await db.select().from(schema.issues).where(eq(schema.issues.issueKey, k)))[0].id;

  beforeAll(async () => {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'WEB_URL']) savedEnv[k] = process.env[k];
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_FROM = 'Helpdesk <help@desk.test>';
    process.env.WEB_URL = 'https://help.desk.test';

    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const inserted = await db.insert(schema.users).values([
      { username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash },
      { username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash },
      { username: 'agnes', email: 'agnes@desk.test', displayName: 'Agnes Agent', passwordHash: hash },
    ]).returning();
    aliceId = inserted[0].id; bobId = inserted[1].id;
    admin = await login('admin'); alice = await login('alice'); agent = await login('agnes');
    await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#00aa00' });
    await db.insert(schema.linkTypes).values([
      { name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ]);

    let res = await call(admin, 'POST', SD, { projectKey: 'TEST', name: 'Comms Desk', slug: 'comms-desk', publicSignup: false });
    expect(res.status).toBe(201);
    deskId = (await res.json()).id;
    res = await call(admin, 'POST', `${SD}/${deskId}/requesttype`, { name: 'General', issueTypeId: seeded.issueType.id, fields: [] });
    rtId = (await res.json()).id;
    await call(admin, 'POST', `${SD}/${deskId}/customer`, { userId: aliceId });
    await call(admin, 'POST', `${SD}/${deskId}/customer`, { userId: bobId });
    res = await call(admin, 'POST', `${SD}/${deskId}/agent`, { userId: inserted[2].id, role: 'agent' });
    expect(res.status).toBeLessThan(300);
  });

  afterAll(async () => {
    setMailTransportForTests(null);
    setMailSourceFactoryForTests(null);
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ---------------- outbound reply mail ---------------- */

  test('public agent comment is mailed to customer and participants with threading headers, internal is not', async () => {
    key = await newRequest(alice, 'Printer <b>broken</b>');
    const requestId = (await db.select().from(schema.serviceRequests))[0].id;
    await db.insert(schema.requestParticipants).values({ requestId, userId: bobId });
    await db.delete(schema.emailQueue);

    const evil = '<script>alert(1)</script> & "quotes"\nsecond line';
    let res = await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: evil });
    expect(res.status).toBe(201);

    const rows = await mails();
    expect(rows.map((r) => r.toAddress).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    const m = rows.find((r) => r.toAddress === 'alice@example.com')!;
    expect(m.subject).toBe(`[${key}] Printer <b>broken</b>`);
    const h = m.headers as Record<string, string>;
    expect(h['Message-ID']).toMatch(new RegExp(`^<req\\.${key}\\.[0-9a-f]{16}@desk\\.test>$`));
    expect(h['In-Reply-To']).toBe(`<req.${key}.root@desk.test>`);
    expect(h.References).toBe(`<req.${key}.root@desk.test>`);
    expect(h['Auto-Submitted']).toBe('auto-replied');
    expect(m.htmlBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.htmlBody).not.toContain('<script>');
    expect(m.htmlBody).toContain(`https://help.desk.test/portal/comms-desk/requests/${key}`);
    expect(m.htmlBody).toContain('View request');
    expect(m.htmlBody).not.toMatch(/Manage notification preferences/);
    expect(m.textBody).toContain('<script>alert(1)</script> & "quotes"\nsecond line');
    expect(m.textBody).toContain('nothing to unsubscribe from');
    // the generic "comment added" mail must not reach the customer side a second time
    expect(rows.filter((r) => r.subject.startsWith('New Comment on'))).toHaveLength(0);

    await db.delete(schema.emailQueue);
    res = await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: 'internal only', internal: true });
    expect(res.status).toBe(201);
    expect((await mails()).filter((r) => r.toAddress.endsWith('@example.com'))).toHaveLength(0);
  });

  test('a second reply threads onto the previous mail', async () => {
    const [first] = await db.select().from(schema.sdOutboundMessages).orderBy(schema.sdOutboundMessages.id);
    expect(first).toBeTruthy();
    await db.delete(schema.emailQueue);
    await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: 'Second reply' });
    const rows = await mails('alice@example.com');
    expect(rows).toHaveLength(1);
    const h = rows[0].headers as Record<string, string>;
    const sent = await db.select().from(schema.sdOutboundMessages).where(eq(schema.sdOutboundMessages.issueId, await issueId(key))).orderBy(schema.sdOutboundMessages.id);
    // previous mail of the request = the last logged id before this one (alice's mail of the first reply or bob's)
    expect(h['In-Reply-To']).not.toBe(`<req.${key}.root@desk.test>`);
    expect(sent.map((s) => s.messageId)).toContain(h['In-Reply-To']);
    expect(h.References).toBe(`<req.${key}.root@desk.test> ${h['In-Reply-To']}`);
  });

  test('queued mail is sent through the transport with the threading headers', async () => {
    const sentMail: any[] = [];
    setMailTransportForTests({ sendMail: async (o: any) => { sentMail.push(o); return {} as any; } });
    const before = await mails();
    await processEmailQueue(50);
    expect(sentMail.length).toBe(before.length);
    const withHeaders = sentMail.filter((s) => s.headers?.['Message-ID']);
    expect(withHeaders.length).toBeGreaterThan(0);
    expect(withHeaders[0].from).toBe('Helpdesk <help@desk.test>');
    expect(withHeaders[0].headers['In-Reply-To']).toMatch(/^<req\./);
    expect(withHeaders[0].html).toContain('View request');
    setMailTransportForTests(null);
  });

  test('Reply-To is set once the channel has a reply address', async () => {
    let res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { replyAddress: 'support@desk.test' });
    expect(res.status).toBe(201);
    await db.delete(schema.emailQueue);
    await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: 'with reply-to' });
    const m = (await mails('alice@example.com'))[0];
    expect((m.headers as any)['Reply-To']).toBe('support@desk.test');
    expect(m.textBody).toContain('reply to this email');
    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { replyAddress: 'not an address' });
    expect(res.status).toBe(400);
  });

  test('status change mail follows the per-desk switch (off by default)', async () => {
    let res = await call(admin, 'GET', `${SD}/${deskId}/notification-settings`);
    expect(await res.json()).toEqual({ notifyCustomerComments: true, notifyCustomerStatus: false });
    const tr = (await (await call(admin, 'GET', `/rest/api/2/issue/${key}/transitions`)).json()).transitions[0];

    await db.delete(schema.emailQueue);
    res = await call(admin, 'POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id: tr.id } });
    expect(res.status).toBe(200);
    expect((await mails()).filter((r) => r.toAddress === 'alice@example.com')).toHaveLength(0);

    // back to To Do through the DB and switch the setting on
    await db.update(schema.issues).set({ statusId: seeded.status.id }).where(eq(schema.issues.issueKey, key));
    res = await call(agent, 'PUT', `${SD}/${deskId}/notification-settings`, { notifyCustomerStatus: true });
    expect(res.status).toBe(403); // agents may read, only desk admins change
    res = await call(admin, 'PUT', `${SD}/${deskId}/notification-settings`, { notifyCustomerStatus: true });
    expect((await res.json()).notifyCustomerStatus).toBe(true);
    res = await call(admin, 'PUT', `${SD}/${deskId}/notification-settings`, { bogus: true });
    expect(res.status).toBe(400);

    await db.delete(schema.emailQueue);
    res = await call(admin, 'POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id: tr.id } });
    expect(res.status).toBe(200);
    const rows = (await mails()).filter((r) => r.toAddress === 'alice@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].textBody).toContain('changed to In Progress');
    expect((rows[0].headers as any)['Auto-Submitted']).toBe('auto-generated');
  });

  test('comments switch off stops reply mails; customers cannot read or change settings', async () => {
    await call(admin, 'PUT', `${SD}/${deskId}/notification-settings`, { notifyCustomerComments: false });
    await db.delete(schema.emailQueue);
    await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: 'muted' });
    expect((await mails()).filter((r) => r.toAddress === 'alice@example.com')).toHaveLength(0);
    await call(admin, 'PUT', `${SD}/${deskId}/notification-settings`, { notifyCustomerComments: true });
    expect((await call(alice, 'GET', `${SD}/${deskId}/notification-settings`)).status).toBe(404);
  });

  test('no SMTP configured: comment succeeds, nothing is queued', async () => {
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    await db.delete(schema.emailQueue);
    const res = await call(admin, 'POST', `/rest/api/2/issue/${key}/comment`, { body: 'no smtp' });
    expect(res.status).toBe(201);
    expect((await mails()).filter((r) => r.toAddress === 'alice@example.com')).toHaveLength(0);
    process.env.SMTP_HOST = host;
  });

  test('per-request hourly cap stops mail floods', async () => {
    const id = await issueId(key);
    const [desk] = await db.select().from(schema.serviceDesks);
    const flood = Array.from({ length: MAX_MAILS_PER_REQUEST_HOUR }, (_, i) => ({ serviceDeskId: desk.id, issueId: id, messageId: `<flood${i}@x>` }));
    await db.insert(schema.sdOutboundMessages).values(flood);
    await db.delete(schema.emailQueue);
    const r = await sendRequestMail({ issueId: id, kind: 'comment', body: 'x' });
    expect(r).toEqual({ queued: 0, skipped: 'rate-limit' });
    await db.delete(schema.sdOutboundMessages).where(eq(schema.sdOutboundMessages.serviceDeskId, desk.id));
  });

  /* ---------------- IMAP configuration ---------------- */

  test('IMAP settings: validation, encrypted password, never returned, disabled by default', async () => {
    let res = await call(admin, 'GET', `${SD}/${deskId}/email-channel`);
    let view = await res.json();
    expect(view.imap.enabled).toBe(false);
    expect(view.imap.passwordSet).toBe(false);
    expect(view.imap.pollSeconds).toBe(300);

    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { pollSeconds: 30 } });
    expect(res.status).toBe(400);
    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { host: '169.254.169.254' } });
    expect(res.status).toBe(400);
    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: true } });
    expect(res.status).toBe(400); // host, user and password missing

    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, {
      enabled: true, defaultRequestTypeId: rtId,
      imap: { host: 'imap.desk.test', port: 993, tls: true, user: 'support@desk.test', password: 'S3cret-pass', folder: 'INBOX', pollSeconds: 60 },
    });
    expect(res.status).toBe(200);
    view = await res.json();
    expect(view.imap).toMatchObject({ host: 'imap.desk.test', user: 'support@desk.test', passwordSet: true, pollSeconds: 60, enabled: false });
    expect(JSON.stringify(view)).not.toContain('S3cret-pass');
    const [ch] = await db.select().from(schema.sdEmailChannels);
    expect(ch.imapPasswordEncrypted).toMatch(/^v1\./);
    expect(ch.imapPasswordEncrypted).not.toContain('S3cret-pass');

    expect((await call(alice, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: true } })).status).toBe(404);
    expect((await call(agent, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: true } })).status).toBe(403);
    // enabling twice keeps the stored password
    res = await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: true } });
    expect((await res.json()).imap.passwordSet).toBe(true);
    await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: false } });
  });

  /* fake mailbox */
  type Msg = { raw: string; seen: boolean; failFetch?: boolean; size?: number };
  const mailbox = new Map<number, Msg>();
  let opened = 0;
  const fakeSource = (): MailSource => ({
    async open() { opened++; },
    async listUnseen(limit) {
      return [...mailbox.entries()].filter(([, m]) => !m.seen).sort((a, b) => a[0] - b[0]).slice(0, limit)
        .map(([uid, m]) => ({ uid, size: m.size ?? m.raw.length }));
    },
    async fetch(uid) {
      const m = mailbox.get(uid)!;
      if (m.failFetch) throw new Error('connection lost');
      return Buffer.from(m.raw.replace(/\n/g, '\r\n'));
    },
    async markSeen(uid) { mailbox.get(uid)!.seen = true; },
    async close() {},
  });
  const mail = (headers: Record<string, string>, body: string, extra = '') =>
    Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') + `\n${extra || 'Content-Type: text/plain; charset=utf-8'}\n\n${body}\n`;

  test('test connection button: ok and error, password never echoed', async () => {
    setMailSourceFactoryForTests(fakeSource);
    let res = await call(admin, 'POST', `${SD}/${deskId}/email-channel/test-connection`, {});
    expect(await res.json()).toEqual({ ok: true, unseen: 0 });
    setMailSourceFactoryForTests(() => ({ ...fakeSource(), open: async () => { throw Object.assign(new Error('x'), { responseText: 'Invalid credentials' }); } }));
    res = await call(admin, 'POST', `${SD}/${deskId}/email-channel/test-connection`, { password: 'new-pass' });
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid credentials' });
    res = await call(admin, 'POST', `${SD}/${deskId}/email-channel/test-connection`, { host: '169.254.169.254' });
    expect((await res.json()).ok).toBe(false);
    expect((await call(alice, 'POST', `${SD}/${deskId}/email-channel/test-connection`, {})).status).toBe(404);
    setMailSourceFactoryForTests(null);
  });

  test('poller: creates, comments, threads by In-Reply-To, ignores loops, stores attachments, marks seen only after success', async () => {
    setMailSourceFactoryForTests(fakeSource);
    await call(admin, 'PUT', `${SD}/${deskId}/email-channel`, { imap: { enabled: true } });
    const existingKey = key;
    await call(admin, 'POST', `/rest/api/2/issue/${existingKey}/comment`, { body: 'Did you reboot?' });
    // a mail we sent for the request: customers reply to its Message-ID with an unrelated subject
    const sentId = (await db.select().from(schema.sdOutboundMessages).where(eq(schema.sdOutboundMessages.issueId, await issueId(existingKey))).orderBy(desc(schema.sdOutboundMessages.id)))[0].messageId;

    mailbox.clear();
    mailbox.set(1, { seen: false, raw: mail({ From: 'Alice <alice@example.com>', To: 'support@desk.test', Subject: 'New laptop needed', 'Message-ID': '<n1@example.com>' }, 'I need a new laptop.\n\n-- \nAlice') });
    mailbox.set(2, { seen: false, raw: mail({ From: 'alice@example.com', To: 'support@desk.test', Subject: `Re: [${existingKey}] Printer`, 'Message-ID': '<n2@example.com>' }, 'Still broken.\n\nOn Mon, 3 Jun 2024, Support <support@desk.test> wrote:\n> did you reboot?') });
    mailbox.set(3, { seen: false, raw: mail({ From: 'alice@example.com', Subject: 'totally different subject', 'Message-ID': '<n3@example.com>', 'In-Reply-To': sentId, References: sentId }, 'Threaded by header.') });
    mailbox.set(4, { seen: false, raw: mail({ From: 'alice@example.com', Subject: 'Out of office', 'Message-ID': '<n4@example.com>', 'Auto-Submitted': 'auto-replied' }, 'I am away') });
    mailbox.set(5, { seen: false, raw: mail({ From: 'MAILER-DAEMON@mx.example.com', Subject: 'Undelivered Mail Returned to Sender', 'Message-ID': '<n5@example.com>' }, 'bounce') });
    mailbox.set(6, { seen: false, raw: mail({ From: 'stranger@nowhere.test', Subject: 'Hello', 'Message-ID': '<n6@nowhere.test>' }, 'Who am I?') });
    mailbox.set(7, { seen: false, raw: mail({ From: 'support@desk.test', Subject: 'Echo', 'Message-ID': '<n7@desk.test>' }, 'our own mailbox') });
    mailbox.set(8, { seen: false, raw: mail({ From: 'Alice <alice@example.com>', Subject: 'With attachment', 'Message-ID': '<n8@example.com>' },
      '--B\nContent-Type: text/plain\n\nSee the log\n--B\nContent-Type: text/plain; name="log.txt"\nContent-Disposition: attachment; filename="log.txt"\nContent-Transfer-Encoding: base64\n\naGVsbG8gd29ybGQ=\n--B\nContent-Type: application/octet-stream; name="big.bin"\nContent-Disposition: attachment; filename="big.bin"\n\nMZxxxx\n--B--',
      'Content-Type: multipart/mixed; boundary="B"') });
    mailbox.set(9, { seen: false, failFetch: true, raw: mail({ From: 'alice@example.com', Subject: 'x', 'Message-ID': '<n9@example.com>' }, 'never fetched') });
    mailbox.set(10, { seen: false, size: 999_999_999, raw: 'huge' });

    const [desk] = await db.select().from(schema.serviceDesks);
    const [ch] = await db.select().from(schema.sdEmailChannels);
    const reqBefore = (await db.select().from(schema.serviceRequests)).length;
    const r: any = await pollDesk(desk, ch);
    expect(r.created).toBe(2); // 1 and 8
    expect(r.commented).toBe(2); // 2 and 3
    expect(r.rejected).toBe(4); // 4,5,6,7
    expect(r.skippedBig).toBe(1);
    expect((await db.select().from(schema.serviceRequests)).length).toBe(reqBefore + 2);

    // seen only after success: the failing fetch stays unseen
    expect([...mailbox.entries()].filter(([, m]) => !m.seen).map(([u]) => u)).toEqual([9]);

    const [created] = await db.select().from(schema.issues).where(eq(schema.issues.summary, 'New laptop needed'));
    expect(created.description).toBe('I need a new laptop.');
    const [creq] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, created.id));
    expect(creq).toMatchObject({ customerId: aliceId, channel: 'email' });

    const cms = await db.select().from(schema.comments).where(eq(schema.comments.issueId, await issueId(existingKey)));
    const bodies = cms.map((c) => c.body);
    expect(bodies).toContain('Still broken.');
    expect(bodies).toContain('Threaded by header.');
    expect(bodies.some((b) => b.includes('did you reboot'))).toBe(false);

    const [withAtt] = await db.select().from(schema.issues).where(eq(schema.issues.summary, 'With attachment'));
    const atts = await db.select().from(schema.attachments).where(eq(schema.attachments.issueId, withAtt.id));
    expect(atts.map((a) => a.filename)).toEqual(['log.txt']); // the executable-looking blob is skipped
    expect(atts[0].authorId).toBe(aliceId);

    const log = await db.select().from(schema.sdInboundMessages);
    expect(log.find((l) => l.messageId === '<n6@nowhere.test>')?.reason).toContain('public signup');
    expect(log.find((l) => l.messageId === '<n4@example.com>')?.reason).toContain('auto-submitted');
    expect(log.find((l) => l.messageId === '<n5@example.com>')?.reason).toContain('bounce');
    expect(log.find((l) => l.messageId === '<n7@desk.test>')?.reason).toContain('self');

    // last poll status is recorded; one failed message makes it an error but the others were handled
    let [row] = await db.select().from(schema.sdEmailChannels);
    expect(row).toMatchObject({ imapLastStatus: 'error', imapLastError: 'connection lost', imapLockUntil: null });
    expect(row.imapLastPollAt).toBeTruthy();

    // fixed: next poll succeeds, a re-delivered (unseen again) message is not processed twice
    mailbox.get(9)!.failFetch = false;
    mailbox.get(2)!.seen = false;
    const cmBefore = (await db.select().from(schema.comments)).length;
    const r2: any = await pollDesk(desk, row);
    expect(r2.processed).toBe(2);
    expect(r2.created).toBe(1); // message 9 (no key in the subject) becomes a request
    expect(r2.commented).toBe(0); // message 2 was only re-delivered: its Message-ID claim makes it a no-op
    void cmBefore;
    [row] = await db.select().from(schema.sdEmailChannels);
    expect(row).toMatchObject({ imapLastStatus: 'ok', imapLastError: null });
    expect([...mailbox.values()].every((m) => m.seen)).toBe(true);
    const stillOne = (await db.select().from(schema.comments).where(eq(schema.comments.body, 'Still broken.')));
    expect(stillOne).toHaveLength(1);
    setMailSourceFactoryForTests(null);
  });

  test('poller scheduling: disabled by default, interval honoured, lease prevents double runs', async () => {
    const [desk] = await db.select().from(schema.serviceDesks);
    setMailSourceFactoryForTests(fakeSource);
    mailbox.clear();

    await db.update(schema.sdEmailChannels).set({ imapEnabled: false, imapLastPollAt: null });
    opened = 0;
    expect(await pollDueDesks()).toBe(0);
    expect(opened).toBe(0);

    await db.update(schema.sdEmailChannels).set({ imapEnabled: true, imapLastPollAt: new Date(), imapPollSeconds: 60 });
    expect(await pollDueDesks()).toBe(0); // polled just now
    expect(await pollDueDesks(Date.now() + 61_000)).toBe(1);

    await db.update(schema.sdEmailChannels).set({ imapLockUntil: new Date(Date.now() + 60_000) });
    const [ch] = await db.select().from(schema.sdEmailChannels);
    expect(await pollDesk(desk, ch)).toEqual({ skipped: 'locked' });
    await db.update(schema.sdEmailChannels).set({ imapLockUntil: null, imapEnabled: false });
    setMailSourceFactoryForTests(null);
  });

  test('HTTP gateway still works and applies the same loop guard', async () => {
    const res = await call(admin, 'POST', `${SD}/${deskId}/email-channel/rotate-secret`);
    const { secret } = await res.json();
    const post = (payload: Record<string, unknown>) => app.request('/rest/servicedeskapi/inbound-email/comms-desk', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Veqsio-Inbound-Secret': secret },
      body: JSON.stringify({ messageId: `<g${Math.random()}@x>`, subject: 'Gateway', text: 'hi', ...payload }),
    });
    expect((await (await post({ from: 'alice@example.com', headers: { 'List-Id': '<l.example.com>' } })).json()).status).toBe('rejected');
    const ok = await post({ from: 'alice@example.com', inReplyTo: undefined });
    expect((await ok.json()).status).toBe('created');
  });

  /* ---------------- raise on behalf ---------------- */

  test('agent raises a request on behalf of a new customer by e-mail', async () => {
    await db.delete(schema.emailQueue);
    let res = await call(agent, 'POST', `${SD}/${deskId}/request`, {
      customerEmail: 'Carol@Customer.test', customerName: 'Carol', requestTypeId: rtId, summary: 'Phone call request', description: 'Please call back',
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    const [carol] = await db.select().from(schema.users).where(eq(schema.users.email, 'carol@customer.test'));
    expect(carol).toMatchObject({ displayName: 'Carol', passwordHash: null });
    expect(out.customerId).toBe(carol.id);
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, out.key));
    expect(issue.reporterId).toBe(carol.id);
    const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id));
    expect(sr).toMatchObject({ customerId: carol.id, channel: 'agent' });
    const note = (await db.select().from(schema.comments).where(eq(schema.comments.issueId, issue.id)))[0];
    expect(note).toMatchObject({ isInternal: true, body: 'Raised on behalf of the customer by Agnes Agent' });
    const [cust] = await db.select().from(schema.serviceDeskCustomers).where(eq(schema.serviceDeskCustomers.userId, carol.id));
    expect(cust).toBeTruthy();
    const m = await mails('carol@customer.test');
    expect(m).toHaveLength(1);
    expect(m[0].textBody).toContain('raised on your behalf by Agnes Agent');
  });

  test('on behalf: existing customer by id or email, validation and permissions', async () => {
    let res = await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, requestTypeId: rtId, summary: 'Via id' });
    expect(res.status).toBe(201);
    const k = (await res.json()).key;
    const r = await call(alice, 'GET', '/rest/servicedeskapi/portal/comms-desk/request');
    expect((await r.json()).values.map((v: any) => v.key)).toContain(k); // the customer sees it as their own
    res = await call(admin, 'POST', `${SD}/${deskId}/request`, { customerEmail: 'alice@example.com', requestTypeId: rtId, summary: 'Via email' });
    expect(res.status).toBe(201);
    expect((await res.json()).customerId).toBe(aliceId);

    expect((await call(alice, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, requestTypeId: rtId, summary: 'x' })).status).toBe(404);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { requestTypeId: rtId, summary: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, customerEmail: 'a@b.io', requestTypeId: rtId, summary: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, requestTypeId: 99999, summary: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: seeded.user.id + 999, requestTypeId: rtId, summary: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, requestTypeId: rtId })).status).toBe(400); // no summary
    expect((await call(admin, 'POST', `${SD}/${deskId}/request`, { customerId: aliceId, requestTypeId: rtId, summary: 'x', reporterId: 1 })).status).toBe(400);
  });

  test('customer autocomplete is for agents only', async () => {
    let res = await call(agent, 'GET', `${SD}/${deskId}/customer-search?q=ali`);
    expect((await res.json()).values.map((u: any) => u.email)).toEqual(['alice@example.com']);
    res = await call(agent, 'GET', `${SD}/${deskId}/customer-search?q=agnes`);
    expect((await res.json()).values).toEqual([]); // agents are not customers
    expect((await call(alice, 'GET', `${SD}/${deskId}/customer-search?q=ali`)).status).toBe(404);
  });

  /* ---------------- merge and link ---------------- */

  test('merge moves comments, attachments, participants, links, closes the source and mails the customer', async () => {
    const src = await newRequest(alice, 'Duplicate report');
    const tgt = await newRequest(alice, 'Original report');
    const srcId = await issueId(src), tgtId = await issueId(tgt);
    const [srcReq] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, srcId));
    await db.insert(schema.requestParticipants).values({ requestId: srcReq.id, userId: bobId });
    await call(alice, 'POST', `/rest/servicedeskapi/portal/comms-desk/request/${src}/comment`, { body: 'customer says hi' });
    await call(admin, 'POST', `/rest/api/2/issue/${src}/comment`, { body: 'agent public' });
    await call(admin, 'POST', `/rest/api/2/issue/${src}/comment`, { body: 'agent internal', internal: true });
    await db.insert(schema.attachments).values({ issueId: srcId, filename: 'a.txt', filesize: 3, mimetype: 'text/plain', storageKey: `merge-test-${Date.now()}`, authorId: aliceId });
    await db.delete(schema.emailQueue);

    // permissions and validation
    expect((await call(alice, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: tgt })).status).toBe(404);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: src })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: 'TEST-99999' })).status).toBe(400);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request/TEST-99999/merge`, { targetKey: tgt })).status).toBe(404);
    expect((await call(admin, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: 'bad key' })).status).toBe(400);

    const res = await call(agent, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: tgt, note: 'Same printer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: src, target: tgt, movedComments: 3, movedAttachments: 1 });

    const tgtComments = (await db.select().from(schema.comments).where(eq(schema.comments.issueId, tgtId))).map((c) => c.body);
    expect(tgtComments).toEqual(expect.arrayContaining(['customer says hi', 'agent public', 'agent internal']));
    expect(tgtComments.some((b) => b.startsWith(`Merged from ${src} by Agnes Agent`) && b.includes('Same printer'))).toBe(true);
    expect(await db.select().from(schema.attachments).where(eq(schema.attachments.issueId, tgtId))).toHaveLength(1);
    expect(await db.select().from(schema.attachments).where(eq(schema.attachments.issueId, srcId))).toHaveLength(0);

    const [tgtReq] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, tgtId));
    const parts = (await db.select().from(schema.requestParticipants).where(eq(schema.requestParticipants.requestId, tgtReq.id))).map((p) => p.userId);
    expect(parts).toEqual([bobId]); // alice is already the customer of the target; bob follows

    const [lt] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.name, 'Duplicate'));
    const [link] = await db.select().from(schema.issueLinks).where(and(eq(schema.issueLinks.linkTypeId, lt.id)));
    // the source reads "duplicates <target>"
    expect(link).toMatchObject({ issueId: tgtId, linkedIssueId: srcId });

    const [srcIssue] = await db.select().from(schema.issues).where(eq(schema.issues.id, srcId));
    const [dupRes] = await db.select().from(schema.resolutions).where(eq(schema.resolutions.name, 'Duplicate'));
    expect(srcIssue.resolutionId).toBe(dupRes.id);
    expect(srcIssue.resolvedAt).toBeTruthy();
    const [st] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, srcIssue.statusId));
    expect(st.category).toBe('done');

    // customer sees the note on the source and was mailed (customer + participant)
    const portal = await (await call(alice, 'GET', `/rest/servicedeskapi/portal/comms-desk/request/${src}`)).json();
    expect(portal.comments.map((c: any) => c.body).join(' ')).toContain(`merged into ${tgt}`);
    const rows = await mails();
    expect(rows.map((r) => r.toAddress).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    expect(rows[0].textBody).toContain(`merged into ${tgt}`);
    expect(rows[0].subject).toBe(`[${src}] Duplicate report`);

    // idempotence and guards
    expect((await call(admin, 'POST', `${SD}/${deskId}/request/${src}/merge`, { targetKey: tgt })).status).toBe(409);
    const other = await newRequest(alice, 'Third');
    const back = await call(admin, 'POST', `${SD}/${deskId}/request/${other}/merge`, { targetKey: src });
    expect(back.status).toBe(409); // target was itself closed as a duplicate
  });

  test('link requests with an existing link type', async () => {
    const a = await newRequest(alice, 'Link A');
    const b = await newRequest(alice, 'Link B');
    const [rel] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.name, 'Relates'));
    let res = await call(agent, 'POST', `${SD}/${deskId}/request/${a}/link`, { targetKey: b, linkTypeId: rel.id });
    expect(res.status).toBe(201);
    const links = await db.select().from(schema.issueLinks).where(eq(schema.issueLinks.linkTypeId, rel.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ issueId: await issueId(b), linkedIssueId: await issueId(a) });
    res = await call(agent, 'POST', `${SD}/${deskId}/request/${b}/link`, { targetKey: a, linkTypeId: rel.id, direction: 'inward' });
    expect(res.status).toBe(409); // same pair and type in the other direction
    expect((await call(agent, 'POST', `${SD}/${deskId}/request/${a}/link`, { targetKey: a, linkTypeId: rel.id })).status).toBe(400);
    expect((await call(agent, 'POST', `${SD}/${deskId}/request/${a}/link`, { targetKey: b, linkTypeId: 99999 })).status).toBe(400);
    expect((await call(alice, 'POST', `${SD}/${deskId}/request/${a}/link`, { targetKey: b, linkTypeId: rel.id })).status).toBe(404);
  });

  test('request meta tells agents who the customer is', async () => {
    const res = await call(admin, 'GET', `/rest/servicedeskapi/request/${key}/meta`);
    expect(await res.json()).toMatchObject({ isRequest: true, staff: true, channel: 'portal', customer: { email: 'alice@example.com' } });
  });
});
