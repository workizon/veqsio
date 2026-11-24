import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('Portal hardening: limits, attachments, IDOR', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, carol: string, dave: string, erin: string;
  let rtId: number;
  let key: string;
  const saved = { ...process.env };

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const upload = (cookie: string, k: string, bytes: Uint8Array, name: string, type: string, field = 'file') => {
    const fd = new FormData();
    fd.append(field, new File([bytes], name, { type }));
    return app.request(`/rest/servicedeskapi/portal/hardening/request/${k}/attachment`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  };

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values(['carol', 'dave', 'erin'].map((n) => ({
      username: n, email: `${n}@example.com`, displayName: n, passwordHash: hash,
    })));
    admin = await login('admin'); carol = await login('carol'); dave = await login('dave'); erin = await login('erin');

    let res = await call(admin, 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Hardening', slug: 'hardening', publicSignup: true });
    expect(res.status).toBe(201);
    const deskId = (await res.json()).id;
    res = await call(admin, 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`, {
      name: 'Help', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id, fields: [],
    });
    rtId = (await res.json()).id;
    // The in-memory limiter outlives table truncation and ids repeat across test files: start clean.
    for (const u of await db.select({ id: schema.users.id }).from(schema.users))
      for (const b of ['req', 'cmt', 'upl']) await redis.del(`veqsio:portal-limit:${b}:${deskId}:${u.id}`);
    for (const c of [carol, dave, erin]) await call(c, 'GET', '/rest/servicedeskapi/portal/hardening');
  });

  afterAll(async () => {
    delete process.env.PORTAL_MAX_REQUESTS_PER_HOUR;
    delete process.env.PORTAL_MAX_COMMENTS_PER_HOUR;
    delete process.env.PORTAL_MAX_UPLOADS_PER_HOUR;
    delete process.env.PORTAL_MAX_ATTACHMENT_BYTES;
    void saved;
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('request creation is limited per user per hour (429 + Retry-After)', async () => {
    process.env.PORTAL_MAX_REQUESTS_PER_HOUR = '20';
    for (let i = 1; i <= 20; i++) {
      const res = await call(carol, 'POST', '/rest/servicedeskapi/portal/hardening/request', { requestTypeId: rtId, summary: `r${i}` });
      expect(res.status).toBe(201);
      if (i === 1) key = (await res.json()).key;
    }
    const res = await call(carol, 'POST', '/rest/servicedeskapi/portal/hardening/request', { requestTypeId: rtId, summary: 'r21' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).errorMessages[0]).toBe('Too many requests. Please try again later.');
    // Other users are unaffected
    const other = await call(dave, 'POST', '/rest/servicedeskapi/portal/hardening/request', { requestTypeId: rtId, summary: 'dave' });
    expect(other.status).toBe(201);
  });

  test('comment limit applies to customers; non-owners still see 404', async () => {
    process.env.PORTAL_MAX_COMMENTS_PER_HOUR = '3';
    for (let i = 0; i < 3; i++) {
      const res = await call(carol, 'POST', `/rest/servicedeskapi/portal/hardening/request/${key}/comment`, { body: `c${i}` });
      expect(res.status).toBe(201);
    }
    const res = await call(carol, 'POST', `/rest/servicedeskapi/portal/hardening/request/${key}/comment`, { body: 'too many' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const nf = await call(erin, 'POST', `/rest/servicedeskapi/portal/hardening/request/${key}/comment`, { body: 'x' });
    expect(nf.status).toBe(404);
    delete process.env.PORTAL_MAX_COMMENTS_PER_HOUR;
  });

  test('customer uploads, lists and downloads an attachment safely', async () => {
    let res = await upload(carol, key, PNG, '../../etc/pass\u0000wd\r\n.png', 'image/png');
    expect(res.status).toBe(201);
    const att = await res.json();
    expect(att.filename).not.toMatch(/[\/\\\u0000\r\n]/);
    expect(att.mimeType).toBe('image/png');

    res = await call(carol, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment`);
    expect((await res.json()).values).toHaveLength(1);

    res = await call(carol, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment/${att.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toStartWith('attachment;');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    // Another customer gets 404 for list, download and upload
    res = await call(erin, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment`);
    expect(res.status).toBe(404);
    res = await call(erin, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment/${att.id}`);
    expect(res.status).toBe(404);
    expect((await upload(erin, key, PNG, 'a.png', 'image/png')).status).toBe(404);
    // Anonymous
    res = await app.request(`/rest/servicedeskapi/portal/hardening/request/${key}/attachment/${att.id}`);
    expect(res.status).toBe(401);
  });

  test('participants can access; agent-internal attachments stay hidden', async () => {
    let res = await call(carol, 'POST', `/rest/servicedeskapi/portal/hardening/request/${key}/participant`, { email: 'erin@example.com' });
    expect(res.status).toBe(204);
    res = await call(erin, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment`);
    expect(res.status).toBe(200);
    expect((await res.json()).values).toHaveLength(1);

    const fd = new FormData();
    fd.append('file', new File(['internal log'], 'internal.txt', { type: 'text/plain' }));
    res = await app.request(`/rest/api/2/issue/${key}/attachments`, { method: 'POST', headers: { Cookie: admin }, body: fd });
    expect(res.status).toBe(201);
    const agentAtt = (await res.json())[0];

    res = await call(carol, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment`);
    expect((await res.json()).values.map((a: any) => a.filename)).not.toContain('internal.txt');
    res = await call(carol, 'GET', `/rest/servicedeskapi/portal/hardening/request/${key}/attachment/${agentAtt.id}`);
    expect(res.status).toBe(404);
  });

  test('upload validation: spoofed type, executables, size, field shape, markup', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    expect((await upload(carol, key, exe, 'a.png', 'image/png')).status).toBe(400);
    expect((await upload(carol, key, exe, 'a.txt', 'application/octet-stream')).status).toBe(400);
    expect((await upload(carol, key, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1]), 'a.bin', 'application/octet-stream')).status).toBe(400);
    expect((await upload(carol, key, enc('hello'), 'a.png', 'image/png')).status).toBe(400);
    expect((await upload(carol, key, PNG, 'a.pdf', 'application/pdf')).status).toBe(400);
    expect((await upload(carol, key, enc('<svg onload=alert(1)>'), 'a.svg', 'image/svg+xml')).status).toBe(400);
    expect((await upload(carol, key, enc('<html>'), 'a.txt', 'text/plain')).status).toBe(400);
    expect((await upload(carol, key, enc('x'), 'a.exe', 'application/x-msdownload')).status).toBe(400);
    expect((await upload(carol, key, PNG, 'a.png', 'image/png', 'other')).status).toBe(400);
    expect((await upload(carol, key, new Uint8Array(0), 'a.txt', 'text/plain')).status).toBe(400);
    process.env.PORTAL_MAX_ATTACHMENT_BYTES = '16';
    expect((await upload(carol, key, new Uint8Array(17).fill(65), 'big.txt', 'text/plain')).status).toBe(413);
    delete process.env.PORTAL_MAX_ATTACHMENT_BYTES;
    expect((await upload(carol, key, enc('fine'), 'ok.txt', 'text/plain')).status).toBe(201);
  });

  test('attachments per request are capped at 20', async () => {
    process.env.PORTAL_MAX_UPLOADS_PER_HOUR = '1000';
    let last = 201;
    for (let i = 0; i < 25 && last === 201; i++) {
      last = (await upload(carol, key, new TextEncoder().encode(`n${i}`), `f${i}.txt`, 'text/plain')).status;
    }
    expect(last).toBe(400);
    const db = createTestDb(testSql);
    const rows = await db.select().from(schema.attachments);
    expect(rows.length).toBe(20);
  });

  test('generic attachment API: customers cannot download or list (IDOR fix)', async () => {
    const db = createTestDb(testSql);
    const rows = await db.select().from(schema.attachments).where(eq(schema.attachments.filename, 'internal.txt'));
    const id = rows[0].id;
    let res = await call(admin, 'GET', `/rest/api/2/attachment/${id}`);
    expect([200, 302]).toContain(res.status);
    res = await call(erin, 'GET', `/rest/api/2/attachment/${id}`);
    expect(res.status).toBe(403);
    res = await call(erin, 'GET', `/rest/api/2/issue/${key}/attachments`);
    expect(res.status).toBe(403);
    res = await call(admin, 'GET', `/rest/api/2/issue/${key}/attachments`);
    expect(res.status).toBe(200);
  });

  test('API responses carry security headers', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  test('a portal-only customer cannot read the people directory or the internal wiki (2026-11-24 audit)', async () => {
    // carol browses no project and holds no global permission: she only exists as a customer of the desk.
    let res = await call(carol, 'GET', '/rest/api/2/user/search?query=');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    res = await call(carol, 'GET', '/rest/api/2/user');
    expect((await res.json()).values).toEqual([]);
    expect((await call(carol, 'GET', '/rest/api/2/user?username=admin')).status).toBe(404);
    res = await call(carol, 'GET', '/rest/api/2/user?username=carol');
    expect(res.status).toBe(200);
    expect((await res.json()).emailAddress).toBe('carol@example.com');

    res = await call(admin, 'POST', '/rest/api/2/pages', { title: 'Internal handbook', body: 'staff only' });
    expect(res.status).toBe(201);
    const pageId = (await res.json()).id;
    for (const [m, u] of [['GET', '/rest/api/2/pages'], ['GET', `/rest/api/2/pages/${pageId}`], ['GET', '/rest/api/2/pages/search?q=handbook'], ['PUT', `/rest/api/2/pages/${pageId}`], ['POST', '/rest/api/2/pages']] as const)
      expect((await call(carol, m, u, m === 'GET' ? undefined : { title: 'x', body: 'y' })).status).toBe(404);

    // staff keep both
    expect(((await (await call(admin, 'GET', '/rest/api/2/user/search?query=carol')).json()) as unknown[]).length).toBe(1);
    expect((await call(admin, 'GET', `/rest/api/2/pages/${pageId}`)).status).toBe(200);
  });

});
