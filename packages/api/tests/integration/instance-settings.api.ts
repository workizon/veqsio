import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateInstanceSettings, checkPasswordPolicy, checkAttachmentPolicy } from '../../src/settings/instance';

describe('Instance settings', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  const clean = async () => { await testSql`DELETE FROM system_settings WHERE key LIKE 'instance.%'`; invalidateInstanceSettings(); };

  beforeAll(async () => {
    testSql = createTestSql();
    await clean();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await clean(); await resetTestDb(testSql); await testSql.end(); });

  test('lists settings with defaults and needs an administrator', async () => {
    const body = await (await call('GET', '/rest/api/2/admin/settings')).json();
    expect(body.settings.find((s: any) => s.key === 'passwordMinLength').value).toBe(8);
    expect((await app.request('/rest/api/2/admin/settings')).status).toBe(401);
    expect((await app.request('/rest/api/2/admin/settings', { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  test('validates values', async () => {
    expect((await call('PUT', '/rest/api/2/admin/settings', { passwordMinLength: 2 })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/admin/settings', { nope: 1 })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/admin/settings', { announcementLevel: 'purple' })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/admin/settings', { attachmentBlockedExtensions: ['ex e'] })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/admin/settings', [])).status).toBe(400);
  });

  test('password policy is enforced when creating users', async () => {
    expect((await call('PUT', '/rest/api/2/admin/settings', { passwordMinLength: 12, passwordRequireMixed: true })).status).toBe(200);
    invalidateInstanceSettings();
    expect(await checkPasswordPolicy('short1')).toContain('at least 12');
    expect(await checkPasswordPolicy('onlyletterslong')).toContain('letter and one digit');
    expect(await checkPasswordPolicy('longenough123')).toBeNull();
    const weak = await call('POST', '/rest/api/2/user', { username: 'weak', email: 'weak@example.com', displayName: 'Weak', password: 'abc12345' });
    expect(weak.status).toBe(400);
    const ok = await call('POST', '/rest/api/2/user', { username: 'strong', email: 'strong@example.com', displayName: 'Strong', password: 'a-long-pass-1234' });
    expect(ok.status).toBeLessThan(300);
  });

  test('attachment policy and the public announcement', async () => {
    await call('PUT', '/rest/api/2/admin/settings', { attachmentMaxMb: 1, attachmentBlockedExtensions: ['.EXE', 'bat'], announcementEnabled: true, announcementLevel: 'warning', announcementMessage: 'Maintenance on Friday' });
    invalidateInstanceSettings();
    expect(await checkAttachmentPolicy(2 * 1024 * 1024, 'a.png')).toContain('max 1 MB');
    expect(await checkAttachmentPolicy(10, 'run.exe')).toContain('.exe');
    expect(await checkAttachmentPolicy(10, 'run.BAT')).toContain('.bat');
    expect(await checkAttachmentPolicy(10, 'photo.png')).toBeNull();
    const pub = await (await app.request('/rest/api/2/settings/public')).json();
    expect(pub.announcement).toEqual({ level: 'warning', message: 'Maintenance on Friday' });
    expect(pub.defaultLanguage).toBe('en');
    await call('PUT', '/rest/api/2/admin/settings', { announcementEnabled: false });
    invalidateInstanceSettings();
    expect((await (await app.request('/rest/api/2/settings/public')).json()).announcement).toBeNull();
  });

  test('login lock and session length follow the settings', async () => {
    expect((await call('PUT', '/rest/api/2/admin/settings', { loginMaxFailures: 3, loginLockMinutes: 20, sessionIdleMinutes: 5, sessionMaxHours: 1 })).status).toBe(200);
    expect((await call('PUT', '/rest/api/2/admin/settings', { loginMaxFailures: 1 })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/admin/settings', { sessionIdleMinutes: 1 })).status).toBe(400);
    invalidateInstanceSettings();
    // after 3 failed sign-ins for the same name and address the 4th is refused with 429
    const attempt = () => app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lock-test', password: 'wrong-password' }) });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 3).every((x) => x === 401)).toBe(true);
    expect(statuses[3]).toBe(429);
    // a fresh session is valid
    const { createSession, deleteSession, getSession } = await import('../../src/auth/session');
    const { getRedisClient } = await import('../../src/services/redis-client');
    const id = await createSession(seeded.user.id);
    expect(await getSession(id)).not.toBeNull();
    // the absolute limit ends a session that is too old, even when it is in use
    const raw = JSON.parse((await getRedisClient().get(`veqsio:session:${id}`))!);
    raw.createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await getRedisClient().setex(`veqsio:session:${id}`, 300, JSON.stringify(raw));
    expect(await getSession(id)).toBeNull();
    await deleteSession(id);
    const keys = await getRedisClient().keys('veqsio:ratelimit:*');
    if (keys.length) await getRedisClient().del(...keys);
  });
});
