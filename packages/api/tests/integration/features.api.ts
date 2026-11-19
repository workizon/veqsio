import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { invalidateFeatures, invalidateProjectFeatures } from '../../src/features';

describe('Feature switches', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('everything is on by default and the list is public to signed-in users', async () => {
    const body = await (await call('GET', '/rest/api/2/features')).json();
    expect(body.features.every((f: any) => f.enabled)).toBe(true);
    expect((await app.request('/rest/api/2/features')).status).toBe(401);
    expect((await app.request('/rest/api/2/admin/features')).status).toBe(401);
  });

  test('switching a feature off closes its API and on restores it', async () => {
    expect((await call('GET', '/rest/api/2/dashboard')).status).toBe(200);
    expect((await call('PUT', '/rest/api/2/admin/features/dashboards', { enabled: false })).status).toBe(200);
    invalidateFeatures();
    expect((await call('GET', '/rest/api/2/dashboard')).status).toBe(404);
    expect((await call('GET', '/rest/api/2/admin/features')).status).toBe(200); // admin stays reachable
    const list = await (await call('GET', '/rest/api/2/features')).json();
    expect(list.features.find((f: any) => f.id === 'dashboards').enabled).toBe(false);
    expect((await call('PUT', '/rest/api/2/admin/features/dashboards', { enabled: true })).status).toBe(200);
    expect((await call('GET', '/rest/api/2/dashboard')).status).toBe(200);
  });

  test('a feature can be switched off for one project only', async () => {
    const a = await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Per project', priority: { id: seeded.priority.id } } })).json();
    const url = `/rest/api/2/issue/${a.key}/approval`;
    expect((await call('GET', url)).status).toBe(200);
    const list = await (await call('GET', '/rest/api/2/project/TEST/features')).json();
    expect(list.features.map((f: any) => f.id)).toContain('approvals');
    expect(list.features.every((f: any) => f.enabled)).toBe(true);
    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { approvals: false } })).status).toBe(200);
    invalidateFeatures(); invalidateProjectFeatures();
    expect((await call('GET', url)).status).toBe(404);
    expect((await (await call('GET', '/rest/api/2/project/TEST/features')).json()).features.find((f: any) => f.id === 'approvals').enabled).toBe(false);
    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { dashboards: false } })).status).toBe(400); // instance-only feature
    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { approvals: 'no' } })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/project/TEST/features', { features: { approvals: true } })).status).toBe(200);
    expect((await call('GET', url)).status).toBe(200);
  });

  test('validates input', async () => {
    expect((await call('PUT', '/rest/api/2/admin/features/nope', { enabled: false })).status).toBe(404);
    expect((await call('PUT', '/rest/api/2/admin/features/dashboards', {})).status).toBe(400);
  });
});
