import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

const CSV = [
  'Summary,Issue key,Issue id,Issue Type,Status,Priority,Assignee,Reporter,Created,Resolved,Labels,Labels,Parent,Comment,Original Estimate,Custom field (Story Points)',
  'Login broken,TEST-10,501,Bug,Done,Medium,carol,dave,15/Mar/23 2:30 PM,16/Mar/23 9:00 AM,auth,urgent,,"16/Mar/23 9:00 AM;carol;Fixed it",2h,3.5',
  'Fix subtask,TEST-11,502,Sub-task,To Do,Medium,,dave,01/Apr/23 8:00 AM,,,,501,,,not-a-number',
  ',TEST-12,503,Task,To Do,,,,,,,,,,,',
  'No key row,,,Task,In Review,,,,2023-05-01,,x,,,,,8',
].join('\n');

describe('CSV import API', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let cookie: string;
  const post = (path: string, body: unknown, ck = cookie) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) });

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('pw-123456', 4) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pw-123456' }),
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('preview suggests a mapping', async () => {
    const res = await post('/rest/api/2/csv-import/preview', { csv: CSV });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(4);
    expect(body.suggestedMapping.summary).toEqual([0]);
    expect(body.suggestedMapping.labels).toEqual([10, 11]);
    expect(body.suggestedMapping.comment).toEqual([13]);
    expect(body.suggestedMapping.storyPoints).toEqual([15]);
  });

  let mapping: any;
  test('dry run reports problems and new reference data without writing', async () => {
    mapping = (await (await post('/rest/api/2/csv-import/preview', { csv: CSV })).json()).suggestedMapping;
    const res = await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'TEST', mapping, dryRun: true });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.dryRun).toBe(true);
    expect(r.errors).toEqual([{ row: 4, message: 'Summary is empty' }]);
    expect(r.newValues.issueTypes).toContain('Bug');
    expect(r.newValues.users).toEqual(expect.arrayContaining(['carol', 'dave']));
    const db = createTestDb(testSql);
    expect(await db.select().from(schema.issues)).toHaveLength(0);
  });

  test('real run imports keys, dates, status, labels, comments, parent and bumps the counter', async () => {
    const res = await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'TEST', mapping, dryRun: false });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ created: 3, failed: 1 });
    expect(r.keys).toEqual(expect.arrayContaining(['TEST-10', 'TEST-11']));

    const db = createTestDb(testSql);
    const [bug] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-10'));
    expect(bug.createdAt?.toISOString()).toBe('2023-03-15T14:30:00.000Z');
    expect(bug.resolvedAt?.toISOString()).toBe('2023-03-16T09:00:00.000Z');
    expect(bug.timeEstimate).toBe(7200);
    expect(Number(bug.storyPoints)).toBe(3.5);
    expect((await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-11')))[0].storyPoints).toBeNull();
    expect(r.warnings.some((w: any) => /story points/i.test(w.message))).toBe(true);
    const [sub] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'TEST-11'));
    expect(sub.parentId).toBe(bug.id);
    const comments = await db.select().from(schema.comments).where(eq(schema.comments.issueId, bug.id));
    expect(comments[0].body).toBe('Fixed it');
    const labels = await db.select().from(schema.issueLabels).where(eq(schema.issueLabels.issueId, bug.id));
    expect(labels).toHaveLength(2);

    // The row without a key got a generated one that does not collide with TEST-10/11.
    const all = await db.select().from(schema.issues);
    expect(new Set(all.map((i) => i.issueKey)).size).toBe(3);
    const [counter] = await db.select().from(schema.projectIssueCounters);
    expect(counter.currentValue).toBeGreaterThanOrEqual(11);
  });

  test('re-run skips existing keys', async () => {
    const r = await (await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'TEST', mapping, dryRun: false })).json();
    expect(r.skipped).toBe(2);
  });

  test('rejects bad mapping, unknown keys, and unauthenticated calls', async () => {
    let res = await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'TEST', mapping: {}, dryRun: true });
    expect(res.status).toBe(400);
    res = await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'TEST', mapping, dryRun: true, evil: 1 });
    expect(res.status).toBe(400);
    res = await post('/rest/api/2/csv-import/run', { csv: CSV, projectKey: 'NOPE', mapping, dryRun: true });
    expect(res.status).toBe(404);
    res = await app.request('/rest/api/2/csv-import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: CSV }) });
    expect(res.status).toBe(401);
  });
});
