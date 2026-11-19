import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Auth API Integration', () => {
  let adminUser: any;
  let testSql: ReturnType<typeof createTestSql>;

  beforeAll(async () => {
    testSql = createTestSql();
    await testSql`SELECT 1`;
    const db = createTestDb(testSql);
    const seeded = await seedTestData(testSql);
    adminUser = seeded.user;

    // Update admin password to a known hash
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('admin123', 12);
    const { users } = await import('@veqsio/db');
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, adminUser.id));
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('POST /rest/auth/1/session returns session cookie on valid login', async () => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBeDefined();
    expect(body.session.name).toBe('session');
    expect(body.session.value).toBeTruthy();

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('session=');
  });

  test('POST /rest/auth/1/session returns 401 for bad credentials', async () => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errorMessages).toContain('Login failed');
  });

  test('DELETE /rest/auth/1/session clears cookie', async () => {
    const loginRes = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get('set-cookie') || '';

    const logoutRes = await app.request('/rest/auth/1/session', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);
    const body = await logoutRes.json();
    expect(body).toEqual({});
  });

  test('GET /health returns ok without auth', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
