import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Security hardening', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  }, 60000);
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); }, 60000);

  test('a percent-encoded letter in the path is refused, so it cannot slip past a guard that looks at the raw path', async () => {
    expect((await call('GET', '/rest/api/2/%61dmin/settings')).status).toBe(400);
    expect((await call('GET', '/rest/api/2/admin/settings')).status).toBe(200);
  });

  test('a scoped token cannot create tokens at all, and no token creates more than it is', async () => {
    const mint = async (scopes: string[], via: Record<string, string> = {}) => call('POST', '/rest/api/2/mypersonalaccessTokens', { name: 't', scopes, expiresInDays: 30 }, via);
    const scoped = await (await mint(['read:*'])).json();
    expect(typeof scoped.token).toBe('string');
    const bearer = { Authorization: `Bearer ${scoped.token}`, Cookie: '' };
    const viaScoped = await app.request('/rest/api/2/mypersonalaccessTokens', { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer }, body: JSON.stringify({ name: 'x', scopes: ['admin'], expiresInDays: 30 }) });
    expect([401, 403]).toContain(viaScoped.status);
    // and the scope check itself: this token may read, not administer
    const admin = await app.request('/rest/api/2/admin/settings', { headers: bearer });
    expect(admin.status).toBe(403);
    const encoded = await app.request('/rest/api/2/%61dmin/settings', { headers: bearer });
    expect(encoded.status).toBe(400);
  });

  test('signing out ends the session on the server', async () => {
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const second = login.headers.get('set-cookie') || '';
    expect((await app.request('/rest/api/2/myself', { headers: { Cookie: second } })).status).toBe(200);
    expect((await app.request('/rest/auth/1/session', { method: 'DELETE', headers: { Cookie: second } })).status).toBe(200);
    expect((await app.request('/rest/api/2/myself', { headers: { Cookie: second } })).status).toBe(401);   // the copied cookie is dead too
  });

  test('a comment can only be edited through the issue it belongs to', async () => {
    const mk = async (summary: string) => (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary } })).json()).key;
    const a = await mk('A'); const b = await mk('B');
    const created = await (await call('POST', `/rest/api/2/issue/${a}/comment`, { body: 'mine' })).json();
    expect((await call('PUT', `/rest/api/2/issue/${b}/comment/${created.id}`, { body: 'x' })).status).toBe(404);
    expect((await call('PUT', `/rest/api/2/issue/${a}/comment/${created.id}`, { body: 'edited' })).status).toBe(200);
    expect((await call('PUT', `/rest/api/2/issue/${a}/comment/${created.id}`, { body: 123 })).status).toBe(400);
    expect((await call('DELETE', `/rest/api/2/issue/${b}/comment/${created.id}`)).status).toBe(404);
  });

  test('the user name admin cannot be taken by registration', async () => {
    const r = await app.request('/rest/auth/1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ADMIN', email: 'x@example.com', password: 'longenough123', displayName: 'X' }) });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test('a web address field takes only http(s)', async () => {
    const [f] = await db.insert(schema.customFields).values({ name: 'Docs link', fieldType: 'url', isGlobal: true }).returning();
    const bad = await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'U', customFields: [{ fieldId: f.id, value: 'javascript:alert(1)' }] } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ok = await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'U2', customFields: [{ fieldId: f.id, value: 'https://example.com/a' }] } });
    expect(ok.status).toBe(201);
  });

  test('what an anonymous visitor learns from serverInfo is small', async () => {
    const anon = await (await app.request('/rest/api/2/serverInfo')).json();
    expect(anon.version).toBeDefined();
    expect(anon.stats).toBeUndefined();
    expect(anon.uptime).toBeUndefined();
    expect(anon.dbStatus).toBeUndefined();
    const signed = await (await call('GET', '/rest/api/2/serverInfo')).json();
    expect(signed.stats).toBeDefined();
  });

  test('the webhook list does not return the signing secret', async () => {
    await db.insert(schema.webhooks).values({ url: 'https://example.com/hook', secret: 'super-secret-value', events: ['issue.created'], active: true } as any);
    const list = await (await call('GET', '/rest/api/2/webhook')).json();
    expect(JSON.stringify(list)).not.toContain('super-secret-value');
    expect(list.webhooks[0].hasSecret).toBe(true);
  });

  test('uploads of markup are refused, and a picture is not just whatever it claims to be', async () => {
    const key = (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'F' } })).json()).key;
    const send = async (name: string, type: string, content: string | Uint8Array) => {
      const fd = new FormData(); fd.append('file', new File([content as BlobPart], name, { type }));
      return app.request(`/rest/api/2/issue/${key}/attachments`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
    };
    expect((await send('page.html', 'text/html', '<script>alert(1)</script>')).status).toBe(400);
    expect((await send('pic.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).status).toBe(400);
    expect((await send('fake.png', 'image/png', '<html>not a png</html>')).status).toBe(400);
    expect((await send('note.txt', 'text/plain', 'hello')).status).toBe(201);
  });
});
