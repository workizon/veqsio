import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Worklog edit and delete permissions', () => {
  let seeded: any;
  let testSql: ReturnType<typeof createTestSql>;
  let cookies: Record<string, string> = {};
  let issueKey: string;
  let issueId: number;
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (username: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }) })).headers.get('set-cookie') || '';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const mk = async (username: string) => (await db.insert(schema.users).values({ username, email: `${username}@veqsio.local`, displayName: username, passwordHash: hash }).returning())[0];
    const [anna, lead, other] = [await mk('anna'), await mk('lead'), await mk('other')];
    for (const u of [anna, lead, other]) {
      for (const perm of ['BROWSE_PROJECTS', 'WORK_ON_ISSUES']) await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: perm, userId: u.id });
    }
    // only `lead` may edit and delete other people's worklogs
    for (const perm of ['EDIT_ALL_WORKLOGS', 'DELETE_ALL_WORKLOGS']) await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: perm, userId: lead.id });
    cookies = { admin: await login('admin'), anna: await login('anna'), lead: await login('lead'), other: await login('other') };
    const created = await (await call('admin', 'POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Time', priority: { id: seeded.priority.id } } })).json();
    issueKey = created.key;
    issueId = Number(created.id);
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  const log = async (who: string) => {
    const res = await call(who, 'POST', `/rest/api/2/issue/${issueKey}/worklog`, { issueId: issueId, issueKey, timeSpentSeconds: 3600, started: new Date().toISOString() });
    expect(res.status).toBeLessThan(300);
    return (await res.json()).id;
  };

  test('the author edits and deletes their own worklog', async () => {
    const id = await log('anna');
    expect((await call('anna', 'PUT', `/rest/api/2/worklog/${id}`, { timeSpentSeconds: 7200 })).status).toBe(200);
    expect((await call('anna', 'DELETE', `/rest/api/2/worklog/${id}`)).status).toBe(200);
  });

  test('someone else cannot, unless they hold Edit All / Delete All Worklogs', async () => {
    const id = await log('anna');
    expect((await call('other', 'PUT', `/rest/api/2/worklog/${id}`, { timeSpentSeconds: 60 })).status).toBe(403);
    expect((await call('other', 'DELETE', `/rest/api/2/worklog/${id}`)).status).toBe(403);
    expect((await call('lead', 'PUT', `/rest/api/2/worklog/${id}`, { timeSpentSeconds: 1800 })).status).toBe(200);
    expect((await call('lead', 'DELETE', `/rest/api/2/worklog/${id}`)).status).toBe(200);
    // a project administrator keeps working as before
    const id2 = await log('anna');
    expect((await call('admin', 'DELETE', `/rest/api/2/worklog/${id2}`)).status).toBe(200);
  });
});
