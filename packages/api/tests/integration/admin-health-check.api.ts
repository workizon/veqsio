import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Admin health check', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let admin: string, bob: string;

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    // A custom field nobody uses, and an issue assigned to a deactivated user
    await db.insert(schema.customFields).values({ name: 'Unused field', fieldType: 'string' });
    const [ghost] = await db.insert(schema.users).values({ username: 'ghost', email: 'ghost@example.com', displayName: 'Ghost', active: false }).returning();
    await db.insert(schema.issues).values({
      issueKey: 'TEST-1', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id,
      summary: 's', reporterId: seeded.user.id, assigneeId: ghost.id,
    });
    await db.insert(schema.projects).values({ projectKey: 'BARE', name: 'Bare project' });
    admin = await login('admin');
    bob = await login('bob');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const get = (ck: string) => app.request('/rest/api/2/admin/health-check', { headers: { Cookie: ck } });

  test('only system administrators can run it', async () => {
    expect((await app.request('/rest/api/2/admin/health-check')).status).toBe(401);
    expect((await get(bob)).status).toBe(403);
  });

  test('reports real configuration problems', async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.checks.map((c: any) => [c.id, c]));
    expect(body.status).toBe('critical');
    expect(byId['default-admin-account']).toMatchObject({ severity: 'critical', items: ['admin'] });
    expect(byId['projects-no-permission-scheme'].items).toContain('BARE');
    expect(byId['projects-no-workflow-scheme'].items).toContain('BARE');
    expect(byId['projects-no-permission-scheme'].items).not.toContain('TEST');
    expect(byId['issues-assigned-to-inactive']).toMatchObject({ severity: 'warning', count: 1, items: ['TEST-1'] });
    expect(byId['custom-fields-unused'].items).toContain('Unused field');
    expect(byId['mail-not-configured']).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});
