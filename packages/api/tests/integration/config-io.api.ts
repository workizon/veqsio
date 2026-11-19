import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateInstanceSettings } from '../../src/settings/instance';
import { invalidateFeatures, invalidateProjectFeatures } from '../../src/features';

describe('Configuration as code', () => {
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const clean = async () => { await testSql`DELETE FROM system_settings WHERE key LIKE 'instance.%' OR key = 'features.disabled'`; invalidateInstanceSettings(); invalidateFeatures(); invalidateProjectFeatures(); };

  beforeAll(async () => {
    testSql = createTestSql();
    await clean();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await clean(); await resetTestDb(testSql); await testSql.end(); });

  test('needs an administrator', async () => {
    expect((await app.request('/rest/api/2/admin/config/export')).status).toBe(401);
    expect((await app.request('/rest/api/2/admin/config/import', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  test('export is a versioned document and round-trips as a no-op', async () => {
    const doc = await (await call('GET', '/rest/api/2/admin/config/export')).json();
    expect(doc.version).toBe(1);
    expect(doc.settings.passwordMinLength).toBe(8);
    expect(doc.projects.find((p: any) => p.key === 'TEST')).toBeTruthy();
    const res = await (await call('POST', '/rest/api/2/admin/config/import?dryRun=true', doc)).json();
    expect(res.errors).toEqual([]);
    expect(res.changes).toEqual([]);
  });

  test('dry run reports changes without applying them; apply is idempotent', async () => {
    const doc = await (await call('GET', '/rest/api/2/admin/config/export')).json();
    doc.settings.passwordMinLength = 14;
    doc.disabledFeatures = ['dashboards'];
    const t = doc.projects.find((p: any) => p.key === 'TEST');
    t.components = [{ name: 'Backend', description: 'API' }];
    t.versions = [{ name: '2.0', releaseDate: '2027-01-31' }];
    t.disabledFeatures = ['approvals'];
    const dry = await (await call('POST', '/rest/api/2/admin/config/import?dryRun=true', doc)).json();
    expect(dry.applied).toBe(false);
    expect(dry.changes.length).toBeGreaterThanOrEqual(5);
    invalidateInstanceSettings();
    expect((await (await call('GET', '/rest/api/2/admin/settings')).json()).settings.find((s: any) => s.key === 'passwordMinLength').value).toBe(8);

    const applied = await (await call('POST', '/rest/api/2/admin/config/import', doc)).json();
    expect(applied.applied).toBe(true);
    invalidateInstanceSettings(); invalidateFeatures(); invalidateProjectFeatures();
    expect((await call('GET', '/rest/api/2/dashboard')).status).toBe(404);
    const again = await (await call('POST', '/rest/api/2/admin/config/import', doc)).json();
    expect(again.changes).toEqual([]);
    const after = await (await call('GET', '/rest/api/2/admin/config/export')).json();
    expect(after.projects.find((p: any) => p.key === 'TEST').components.map((c: any) => c.name)).toContain('Backend');
  });

  test('errors apply nothing', async () => {
    const bad = { version: 1, settings: { passwordMinLength: 2 }, disabledFeatures: ['nope'], projects: [{ key: 'TEST', disabledFeatures: ['dashboards'] }, { key: 'GONE' }] };
    const res = await call('POST', '/rest/api/2/admin/config/import', bad);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.errors.length).toBeGreaterThanOrEqual(3);
    expect(body.warnings.join(' ')).toContain('GONE');
    expect((await call('POST', '/rest/api/2/admin/config/import', { version: 2 })).status).toBe(400);
    expect((await call('POST', '/rest/api/2/admin/config/import', null)).status).toBe(400);
  });
});
