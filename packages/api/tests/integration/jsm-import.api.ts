import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { JiraClient } from '../../src/migration/rest/client';
import { importServiceDesks } from '../../src/migration/rest/jsm';

/** A fake Jira: answers the service desk REST paths the importer uses. */
function fakeJira(): typeof fetch {
  const json = (o: unknown) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const page = (values: unknown[]) => json({ values, isLastPage: true, size: values.length });
  return (async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).pathname;
    if (p === '/rest/servicedeskapi/servicedesk') return page([{ id: '1', projectId: '10', projectKey: 'TEST', projectName: 'Test Desk' }, { id: '2', projectId: '11', projectKey: 'GONE', projectName: 'Not imported' }]);
    if (p === '/rest/servicedeskapi/servicedesk/1/requesttypegroup') return page([{ id: '5', name: 'Hardware' }]);
    if (p === '/rest/servicedeskapi/servicedesk/1/requesttype') return page([{ id: '7', name: 'Broken laptop', description: 'It does not start', helpText: 'Tell us the model', issueTypeId: '3', groupIds: ['5'] }, { id: '8', name: 'Get access', issueTypeId: '3', groupIds: [] }]);
    if (p === '/rest/servicedeskapi/servicedesk/1/requesttype/7/field') return json({ requestTypeFields: [
      { fieldId: 'summary', name: 'Summary', required: true, visible: true, jiraSchema: { type: 'string' } },
      { fieldId: 'description', name: 'Describe it', required: false, visible: true, jiraSchema: { type: 'string' } },
      { fieldId: 'customfield_10020', name: 'Laptop model', required: true, visible: true, jiraSchema: { type: 'option' }, validValues: [{ label: 'ThinkPad' }, { label: 'MacBook' }] },
      { fieldId: 'attachment', name: 'Photos', visible: true },
    ] });
    if (p === '/rest/servicedeskapi/servicedesk/1/requesttype/8/field') return json({ requestTypeFields: [{ fieldId: 'summary', name: 'Summary', required: true, visible: true, jiraSchema: { type: 'string' } }] });
    if (p === '/rest/api/2/issuetype/3') return json({ id: '3', name: 'IT Help' });
    if (p === '/rest/servicedeskapi/servicedesk/1/queue') return page([{ id: '1', name: 'All open', jql: 'resolution = Unresolved ORDER BY created DESC' }, { id: '2', name: 'Broken', jql: 'this is ??? not jql' }]);
    if (p === '/rest/servicedeskapi/servicedesk/1/organization') return page([{ id: '9', name: 'Acme Inc' }]);
    if (p === '/rest/servicedeskapi/organization/9/user') return page([{ accountId: 'abc', name: 'carol', emailAddress: 'carol@acme.example', displayName: 'Carol' }]);
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

describe('Jira Service Management import', () => {
  let seeded: any; let admin = ''; let bob = '';
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const client = () => new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, fetchImpl: fakeJira(), retries: 0 });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'jsmbob', email: 'jsmbob@x.test', displayName: 'Bob', passwordHash: hash });
    const login = async (u: string) => (await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pw-123456' }) })).headers.get('set-cookie') || '';
    admin = await login('admin'); bob = await login('jsmbob');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('creates the desk, request types with forms and groups, queues, organizations and customers; reports what it could not do', async () => {
    const r = await importServiceDesks(client(), { projectKeys: [] });
    expect(r.errors).toEqual([]);
    expect(r.desks.TEST).toMatchObject({ created: true, requestTypes: 2, groups: 1, queues: 2, organizations: 1, customers: 1 });
    expect(r.desks.GONE).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('GONE') && w.includes('Jira import first'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('SLA definitions'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Broken') && w.includes('JQL'))).toBe(true);
    expect(r.usersCreated).toBe(1);

    const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, seeded.project.id));
    expect(desk).toMatchObject({ name: 'Test Desk', slug: 'test-desk' });
    const types = await db.select().from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, desk.id));
    const laptop = types.find((t) => t.name === 'Broken laptop')!;
    expect(laptop.groupName).toBe('Hardware');
    expect((laptop.fields as any[]).map((f) => f.key)).toEqual(['summary', 'description', 'customfield_10020']);
    expect((laptop.fields as any[])[2]).toMatchObject({ type: 'select', options: ['ThinkPad', 'MacBook'], required: true });
    const [issueType] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, laptop.issueTypeId));
    expect(issueType.name).toBe('IT Help');
    const queues = await db.select().from(schema.serviceQueues).where(eq(schema.serviceQueues.serviceDeskId, desk.id));
    expect(queues.find((q) => q.name === 'All open')!.jql).toContain('Unresolved');
    expect(queues.find((q) => q.name === 'Broken')!.jql).toBeNull();
    const [org] = await db.select().from(schema.customerOrganizations).where(eq(schema.customerOrganizations.serviceDeskId, desk.id));
    expect(org.name).toBe('Acme Inc');
    const customers = await db.select().from(schema.serviceDeskCustomers).where(eq(schema.serviceDeskCustomers.serviceDeskId, desk.id));
    expect(customers.length).toBe(1);
    expect(customers[0].organizationId).toBe(org.id);
  });

  test('running it again updates instead of duplicating', async () => {
    const again = await importServiceDesks(client(), { projectKeys: ['TEST'] });
    expect(again.desks.TEST.created).toBe(false);
    expect(again.usersCreated).toBe(0);
    const [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, seeded.project.id));
    expect((await db.select().from(schema.requestTypes).where(eq(schema.requestTypes.serviceDeskId, desk.id))).length).toBe(2);
    expect((await db.select().from(schema.serviceQueues).where(eq(schema.serviceQueues.serviceDeskId, desk.id))).length).toBe(2);
    expect((await db.select().from(schema.customerOrganizations).where(eq(schema.customerOrganizations.serviceDeskId, desk.id))).length).toBe(1);
    expect((await db.select().from(schema.serviceDeskCustomers).where(eq(schema.serviceDeskCustomers.serviceDeskId, desk.id))).length).toBe(1);
  });

  test('a Jira without Service Management is reported, not thrown; the routes are for system administrators', async () => {
    const noJsm = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, retries: 0, fetchImpl: (async () => new Response('{}', { status: 404 })) as typeof fetch });
    const r = await importServiceDesks(noJsm);
    expect(r.errors[0]).toContain('Could not list service desks');
    const body = JSON.stringify({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' } });
    for (const path of ['analyze', 'run']) {
      expect((await app.request(`/rest/api/2/migration/rest/jsm/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob }, body })).status).toBe(403);
      expect((await app.request(`/rest/api/2/migration/rest/jsm/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
    }
  });
});
