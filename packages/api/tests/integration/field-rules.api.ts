import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { and, eq } from 'drizzle-orm';
import app from '../../src/app';

describe('Required custom fields and defaults on a new issue', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let fieldId: number;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const create = (customFields?: unknown, summary = 'Rules test') =>
    call('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary, ...(customFields ? { customFields } : {}) } });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash('admin123', 12) }).where(eq(schema.users.id, seeded.user.id));
    const login = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    cookie = login.headers.get('set-cookie') || '';
    const [f] = await db.insert(schema.customFields).values({ name: 'Customer impact', fieldType: 'select', isGlobal: true }).returning();
    fieldId = f.id;
    const [ctx] = await db.insert(schema.customFieldContexts).values({ customFieldId: f.id, projectId: null, issueTypeId: null, defaultValue: 'Low' }).returning();
    await db.insert(schema.customFieldOptions).values([{ customFieldId: f.id, contextId: ctx.id, value: 'Low', sortOrder: 0 }, { customFieldId: f.id, contextId: ctx.id, value: 'High', sortOrder: 1 }]);
  }, 60000);
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); }, 60000);

  const valueOf = async (key: string) => {
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    const [v] = await db.select().from(schema.customFieldValues).where(and(eq(schema.customFieldValues.issueId, issue.id), eq(schema.customFieldValues.customFieldId, fieldId)));
    return v?.stringValue ?? null;
  };

  test('a context default fills a field the caller did not send', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(await valueOf((await r.json()).key)).toBe('Low');
  });

  test('a value that is sent wins over the default', async () => {
    const r = await create([{ fieldId, value: 'High' }]);
    expect(r.status).toBe(201);
    expect(await valueOf((await r.json()).key)).toBe('High');
  });

  test('the create metadata tells the form what is required and the default', async () => {
    const [cfg] = await db.insert(schema.fieldConfigurations).values({ name: 'Needs impact' }).returning();
    await db.insert(schema.fieldConfigurationItems).values({ configId: cfg.id, fieldId, isCustomField: true, isVisible: true, isRequired: true });
    await db.insert(schema.fieldConfigurationSchemeAssociations).values({ projectId: seeded.project.id, issueTypeId: seeded.issueType.id, configId: cfg.id });
    const meta = await (await call('GET', `/rest/api/2/issue/createmeta?projectIds=${seeded.project.id}&expand=projects.issuetypes.fields`)).json();
    const f = meta.projects[0].issuetypes.find((t: any) => t.id === String(seeded.issueType.id)).fields[`customfield_${fieldId}`];
    expect(f.required).toBe(true);
    expect(f.defaultValue).toBe('Low');
  });

  test('a required field without a value (and without a default) is refused with its name', async () => {
    await db.delete(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, fieldId));
    const r = await create();
    expect(r.status).toBe(400);
    expect((await r.json()).errorMessages[0]).toContain('Customer impact');
    const blank = await create([{ fieldId, value: '' }]);
    expect(blank.status).toBe(400);
    const ok = await create([{ fieldId, value: 'High' }]);
    expect(ok.status).toBe(201);
  });
});
