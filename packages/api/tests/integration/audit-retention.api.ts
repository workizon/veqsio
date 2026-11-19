import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import { useTestLicense, clearTestLicense } from '../test-license';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateInstanceSettings } from '../../src/settings/instance';
import { runAuditRetention, cutoffFor } from '../../src/audit/retention';

describe('Audit log retention (Enterprise)', () => {
  let admin = '';
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const put = (body: unknown) => app.request('/rest/api/2/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: JSON.stringify(body) });
  const count = async () => Number((await testSql`SELECT count(*)::int AS n FROM audit_log WHERE action <> 'audit.retention' AND action LIKE 'test.%'`)[0].n);
  const seedRows = async () => {
    await testSql`DELETE FROM audit_log WHERE action LIKE 'test.%'`;
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await testSql`INSERT INTO audit_log (created_at, action, target_type, actor_name) VALUES (${old}, 'test.old1', 'x', 'a'), (${old}, 'test.old2', 'x', 'a'), (${fresh}, 'test.fresh', 'x', 'a')`;
  };

  beforeAll(async () => {
    await clearTestLicense();
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    admin = (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pw-123456' }) })).headers.get('set-cookie') || '';
  });
  afterAll(async () => {
    await testSql`DELETE FROM system_settings WHERE key LIKE 'instance.%'`; invalidateInstanceSettings();
    await clearTestLicense(); await resetTestDb(testSql); await testSql.end();
  });

  test('the cutoff is days before now', () => {
    const now = new Date('2026-06-30T12:00:00Z');
    expect(cutoffFor(30, now).toISOString()).toBe('2026-05-31T12:00:00.000Z');
  });

  test('without the licence the setting is refused (402) and nothing is ever deleted', async () => {
    await clearTestLicense();
    const r = await put({ auditRetentionDays: 30 });
    expect(r.status).toBe(402);
    expect((await r.json()).feature).toBe('audit_retention');
    expect((await put({ auditRetentionDays: 0 })).status).toBe(200); // switching back to "keep everything" is always allowed
    await seedRows();
    // even if a value were stored (for example from an earlier licence), the job does nothing without the feature
    await testSql`INSERT INTO system_settings (key, value) VALUES ('instance.auditRetentionDays', '30') ON CONFLICT (key) DO UPDATE SET value = '30'`; invalidateInstanceSettings();
    expect(await runAuditRetention()).toBe(0);
    expect(await count()).toBe(3);
  });

  test('with the licence old entries go, fresh ones stay, one entry records the cleanup; 0 keeps everything', async () => {
    await useTestLicense({ plan: 'enterprise' });
    await seedRows();
    expect((await put({ auditRetentionDays: 0 })).status).toBe(200);
    expect(await runAuditRetention()).toBe(0);
    expect(await count()).toBe(3);

    expect((await put({ auditRetentionDays: 30 })).status).toBe(200);
    expect((await put({ auditRetentionDays: -5 })).status).toBe(400);
    const removed = await runAuditRetention();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await count()).toBe(1);
    const rec = await testSql`SELECT details FROM audit_log WHERE action = 'audit.retention' ORDER BY id DESC LIMIT 1`;
    expect(rec[0].details.removed).toBe(removed);
    expect(rec[0].details.retentionDays).toBe(30);
    // nothing left to remove: no new record
    const before = Number((await testSql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'audit.retention'`)[0].n);
    expect(await runAuditRetention()).toBe(0);
    expect(Number((await testSql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'audit.retention'`)[0].n)).toBe(before);
  });
});
