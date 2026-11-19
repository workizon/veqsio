import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Customers', () => {
  let seeded: any; let cookie: string; let bobCookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  const as = (ck: () => string) => (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: ck() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = as(() => cookie); const callBob = as(() => bobCookie);
  const P = '/rest/api/2/customer';

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'custbob', email: 'custbob@example.com', displayName: 'Bob', active: true, passwordHash: await bcrypt.hash('bob12345', 12) });
    const login = async (u: string, p: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie') || '';
    cookie = await login('admin', 'admin123'); bobCookie = await login('custbob', 'bob12345');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('needs login and validates', async () => {
    expect((await app.request(P)).status).toBe(401);
    expect((await call('POST', P, { name: '' })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', importance: 9 })).status).toBe(400);
    expect((await call('POST', P, { name: 'X', currency: 'usd' })).status).toBe(400);
  });

  test('create, duplicate, link to an issue, see it on both sides, edit rights, unlink', async () => {
    const r = await call('POST', P, { name: 'Acme Corp', importance: 5, annualRevenue: 120000, currency: 'EUR', description: 'Key account' });
    expect(r.status).toBe(201);
    const cu = await r.json();
    expect(cu).toMatchObject({ name: 'Acme Corp', importance: 5, annualRevenue: 120000, currency: 'EUR' });
    expect((await call('POST', P, { name: 'ACME corp' })).status).toBe(409);

    const issue = await (await call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Acme needs SSO' } })).json();
    const link = await call('POST', `/rest/api/2/issue/${issue.key}/customer`, { customerId: cu.id, note: 'Blocks their renewal' });
    expect(link.status).toBe(201);
    expect((await call('POST', `/rest/api/2/issue/${issue.key}/customer`, { customerId: 999999 })).status).toBe(404);

    const onIssue = await (await call('GET', `/rest/api/2/issue/${issue.key}/customer`)).json();
    expect(onIssue.customers[0]).toMatchObject({ id: cu.id, note: 'Blocks their renewal' });
    const detail = await (await call('GET', `${P}/${cu.id}`)).json();
    expect(detail.issues.map((i: any) => i.key)).toEqual([issue.key]);
    expect(detail.canEdit).toBe(true);
    const list = await (await call('GET', `${P}?query=acm`)).json();
    expect(list.customers[0]).toMatchObject({ id: cu.id, linkedIssues: 1 });

    // another user: may read, may not change
    expect((await callBob('GET', `${P}/${cu.id}`)).status).toBe(200);
    expect((await callBob('PUT', `${P}/${cu.id}`, { name: 'Hijack' })).status).toBe(403);
    expect((await callBob('DELETE', `${P}/${cu.id}`)).status).toBe(403);

    expect((await call('DELETE', `/rest/api/2/issue/${issue.key}/customer/${cu.id}`)).status).toBe(204);
    expect((await (await call('GET', `${P}/${cu.id}`)).json()).issues).toEqual([]);
    expect((await call('DELETE', `${P}/${cu.id}`)).status).toBe(204);
  });
});
