import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Custom field values: colour, description, archive', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let fieldId: number;
  let contextId: number;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const options = async () => ((await (await call('GET', '/rest/api/2/admin/customfield')).json()).customFields.find((f: any) => f.id === fieldId).options as any[]);

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    fieldId = (await (await call('POST', '/rest/api/2/admin/customfield', { name: 'Environment', fieldType: 'select' })).json()).id;
    contextId = (await (await call('POST', `/rest/api/2/admin/customfield/${fieldId}/context`, {})).json()).id;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('values carry a colour and a description and validate input', async () => {
    const add = (body: object) => call('POST', `/rest/api/2/admin/customfield/${fieldId}/option`, { contextId, ...body });
    expect((await add({ value: 'Production', color: '#dc2626', description: 'Live system' })).status).toBe(201);
    expect((await add({ value: 'Staging', color: 'red' })).status).toBe(400);
    const prod = (await options()).find((o) => o.value === 'Production');
    expect(prod).toMatchObject({ color: '#dc2626', description: 'Live system', archived: false });
    const put = await call('PUT', `/rest/api/2/admin/customfield/${fieldId}/option/${prod.id}`, { color: '#16a34a', description: null });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ color: '#16a34a', description: null });
    expect((await call('PUT', `/rest/api/2/admin/customfield/${fieldId}/option/${prod.id}`, { nope: 1 })).status).toBe(400);
    expect((await call('PUT', `/rest/api/2/admin/customfield/${fieldId}/option/999999`, { value: 'x' })).status).toBe(404);
    expect((await app.request(`/rest/api/2/admin/customfield/${fieldId}/option/${prod.id}`, { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  test('a value that issues carry is archived instead of deleted; an unused one is deleted', async () => {
    const add = async (value: string) => (await (await call('POST', `/rest/api/2/admin/customfield/${fieldId}/option`, { contextId, value })).json()).id as number;
    const used = await add('Legacy');
    const unused = await add('Spare');
    const db = createTestDb(testSql);
    const [issue] = await db.insert(schema.issues).values({ issueKey: 'TEST-900', projectId: seeded.project.id, issueTypeId: seeded.issueType.id, statusId: seeded.status.id, summary: 'x', reporterId: seeded.user.id }).returning();
    await db.insert(schema.customFieldValues).values({ issueId: issue.id, customFieldId: fieldId, stringValue: 'Legacy' });
    const del1 = await (await call('DELETE', `/rest/api/2/admin/customfield/${fieldId}/option/${used}`)).json();
    expect(del1).toMatchObject({ archived: true, usedBy: 1 });
    const del2 = await (await call('DELETE', `/rest/api/2/admin/customfield/${fieldId}/option/${unused}`)).json();
    expect(del2).toMatchObject({ deleted: true });
    const left = await options();
    expect(left.find((o) => o.value === 'Legacy')).toMatchObject({ archived: true });
    expect(left.find((o) => o.value === 'Spare')).toBeUndefined();
    // restore
    await call('PUT', `/rest/api/2/admin/customfield/${fieldId}/option/${used}`, { archived: false });
    expect((await options()).find((o) => o.value === 'Legacy')).toMatchObject({ archived: false });
  });
});
