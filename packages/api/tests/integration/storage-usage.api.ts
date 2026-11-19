import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Attachment storage usage', () => {
  let seeded: any; let admin = ''; let bob = '';
  let testSql: ReturnType<typeof createTestSql>;
  const get = (ck: string) => app.request('/rest/api/2/admin/system/storage', { headers: { Cookie: ck } });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'stbob', email: 'stbob@x.test', displayName: 'Bob', passwordHash: hash });
    const login = async (u: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
    admin = await login('admin'); bob = await login('stbob');
    const [issue] = await db.insert(schema.issues).values({ projectId: seeded.project.id, issueKey: 'TEST-5', issueNumber: 5, summary: 's', issueTypeId: seeded.issueType.id, statusId: seeded.status.id, priorityId: seeded.priority.id, reporterId: seeded.user.id } as any).returning();
    await db.insert(schema.attachments).values([
      { issueId: issue.id, filename: 'a.zip', filesize: 5_000_000_000, mimetype: 'application/zip', storageKey: 'k/a', authorId: seeded.user.id },
      { issueId: issue.id, filename: 'b.png', filesize: 1234, mimetype: 'image/png', storageKey: 'k/b', authorId: seeded.user.id },
    ]);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('administrators only; sums files and bytes per project, including sizes above 2 GB', async () => {
    expect((await app.request('/rest/api/2/admin/system/storage')).status).toBe(401);
    expect((await get(bob)).status).toBe(403);
    const r = await (await get(admin)).json();
    expect(r.projects[0]).toMatchObject({ key: seeded.project.projectKey, files: 2, bytes: 5_000_001_234 });
    expect(r).toMatchObject({ totalFiles: 2, totalBytes: 5_000_001_234 });
    expect(typeof r.backend).toBe('string');
    expect(r.maxFileSizeBytes).toBeGreaterThan(0);
  });
});
