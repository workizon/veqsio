import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { logger, setRuntimeLevel } from '../../src/ops/logger';
import { invalidateInstanceSettings } from '../../src/settings/instance';

describe('Operations: logs, maintenance mode, storage quota', () => {
  let seeded: any; let cookie: string; let adminCookie: string;
  let testSql: ReturnType<typeof createTestSql>; let db: ReturnType<typeof createTestDb>;
  const call = (method: string, path: string, body?: unknown, c = adminCookie) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const [bob] = await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', active: true, passwordHash: await bcrypt.hash('bobbob123', 12) }).returning();
    const login = async (u: string, p: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie') || '';
    adminCookie = await login('admin', 'admin123');
    cookie = await login('bob', 'bobbob123');
    void bob;
  }, 60000);
  afterAll(async () => { setRuntimeLevel(null); await resetTestDb(testSql); await testSql.end(); }, 60000);

  test('the log is for administrators, filterable, and masks e-mail addresses', async () => {
    expect((await call('GET', '/rest/api/2/admin/system/logs', undefined, cookie)).status).toBe(403);
    logger.warn('probe message for the viewer, contact ann@example.com');
    const r = await (await call('GET', '/rest/api/2/admin/system/logs?q=probe%20message')).json();
    expect(r.records.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.records)).not.toContain('ann@example.com');
    const errorsOnly = await (await call('GET', '/rest/api/2/admin/system/logs?level=error&q=probe%20message')).json();
    expect(errorsOnly.records).toHaveLength(0);
  });

  test('the log level can be raised for a while and put back', async () => {
    const up = await (await call('PUT', '/rest/api/2/admin/system/log-level', { level: 'debug', minutes: 5 })).json();
    expect(up.effective).toBe('debug');
    expect(up.temporary.level).toBe('debug');
    logger.debug('debug line that is visible now');
    expect((await (await call('GET', '/rest/api/2/admin/system/logs?q=debug%20line%20that')).json()).records.length).toBe(1);
    const back = await (await call('PUT', '/rest/api/2/admin/system/log-level', { level: null })).json();
    expect(back.temporary).toBeNull();
    expect((await call('PUT', '/rest/api/2/admin/system/log-level', { level: 'trace' })).status).toBe(400);
  });

  test('slow queries say how to switch them on when the extension is not loaded', async () => {
    const r = await (await call('GET', '/rest/api/2/admin/system/slow-queries')).json();
    expect(typeof r.enabled).toBe('boolean');
    if (!r.enabled) expect(r.howTo).toContain('pg_stat_statements');
  });

  test('maintenance mode: people get 503 with the message, administrators carry on, sign-in and health stay up', async () => {
    const on = await call('PUT', '/rest/api/2/admin/settings', { maintenanceEnabled: true, maintenanceMessage: 'Upgrading, back at noon.' });
    expect(on.status).toBe(200);
    invalidateInstanceSettings();
    const blocked = await call('GET', '/rest/api/2/myself', undefined, cookie);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBe('300');
    expect((await blocked.json()).errorMessages[0]).toBe('Upgrading, back at noon.');
    expect((await call('GET', '/rest/api/2/myself')).status).toBe(200);                       // an administrator
    expect((await app.request('/rest/api/2/settings/public')).status).toBe(200);
    expect((await (await app.request('/rest/api/2/settings/public')).json()).maintenance.message).toBe('Upgrading, back at noon.');
    const signIn = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'bobbob123' }) });
    expect(signIn.status).toBe(200);
    await call('PUT', '/rest/api/2/admin/settings', { maintenanceEnabled: false });
    invalidateInstanceSettings();
    expect((await call('GET', '/rest/api/2/myself', undefined, cookie)).status).toBe(200);
  });

  test('a project that is over its storage limit refuses a new attachment; the limit is per project and 0 removes it', async () => {
    const key = (await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Q' } })).json()).key;
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    await db.insert(schema.attachments).values({ issueId: issue.id, filename: 'old.bin', filesize: 3 * 1024 * 1024, mimetype: 'application/octet-stream', storageKey: 'attachments/x/old.bin', authorId: seeded.user.id } as any);
    const send = async () => { const fd = new FormData(); fd.append('file', new File(['hello world'], 'n.txt', { type: 'text/plain' })); return app.request(`/rest/api/2/issue/${key}/attachments`, { method: 'POST', headers: { Cookie: adminCookie }, body: fd }); };
    expect((await send()).status).toBe(201);
    const set = await call('PUT', `/rest/api/2/admin/system/storage/quota/${seeded.project.projectKey ?? 'TEST'}`, { quotaMb: 2 });
    expect(set.status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(400);
    expect((await refused.json()).errorMessages[0]).toContain('attachment storage limit');
    const report = await (await call('GET', '/rest/api/2/admin/system/storage')).json();
    expect(report.projects.find((p: any) => p.key === (seeded.project.projectKey ?? 'TEST')).quotaMb).toBe(2);
    await call('PUT', `/rest/api/2/admin/system/storage/quota/${seeded.project.projectKey ?? 'TEST'}`, { quotaMb: 0 });
    expect((await send()).status).toBe(201);
    expect((await call('PUT', '/rest/api/2/admin/system/storage/quota/NOPE', { quotaMb: 1 })).status).toBe(404);
  });
});
