import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { importSchemes } from '../../src/migration/rest/schemes';
import { Resolver } from '../../src/migration/resolver';
import { db as appDb } from '../../src/db';

const jiraPerm = {
  permissionSchemes: [{
    id: 10, name: 'Jira dev scheme', description: 'from Jira',
    permissions: [
      { permission: 'BROWSE_PROJECTS', holder: { type: 'anyone' } },
      { permission: 'CREATE_ISSUES', holder: { type: 'group', group: { name: 'jira-devs' } } },
      { permission: 'EDIT_ISSUES', holder: { type: 'projectRole', projectRole: { name: 'Developers' } } },
      { permission: 'EDIT_ISSUES', holder: { type: 'projectRole', projectRole: { name: 'Developers' } } },
      { permission: 'ASSIGN_ISSUES', holder: { type: 'projectLead' } },
      { permission: 'DELETE_ISSUES', holder: { type: 'reporter' } },
      { permission: 'VIEW_DEV_TOOLS', holder: { type: 'anyone' } },
    ],
  }],
};
const jiraNotif = {
  id: 5, name: 'Jira notifications',
  notificationSchemeEvents: [
    { event: { name: 'Issue Created' }, notifications: [{ notificationType: 'CurrentAssignee' }, { notificationType: 'Reporter' }] },
    { event: { name: 'Issue Commented' }, notifications: [{ notificationType: 'AllWatchers' }, { notificationType: 'Group' }] },
  ],
};
const client = {
  get: async (path: string) => {
    if (path === '/rest/api/2/role') return [{ id: 10002, name: 'Developers' }];
    if (path.startsWith('/rest/api/2/permissionscheme')) return jiraPerm;
    if (path.endsWith('/permissionscheme')) return { id: 10 };
    if (path.endsWith('/notificationscheme')) return jiraNotif;
    throw new Error('unexpected ' + path);
  },
} as any;
// Data Center answers in the same shape, with roles by id, people by login and "lead" for the project lead
const dcClient = {
  get: async (path: string) => {
    if (path === '/rest/api/2/role') return [{ id: 10002, name: 'DC Developers' }];
    if (path.startsWith('/rest/api/2/permissionscheme')) return { permissionSchemes: [{ id: 20, name: 'DC scheme', permissions: [
      { permission: 'EDIT_ISSUES', holder: { type: 'projectRole', parameter: '10002' } },
      { permission: 'ASSIGN_ISSUES', holder: { type: 'lead' } },
      { permission: 'CREATE_ISSUES', holder: { type: 'user', parameter: 'nobody-here' } },
    ] }] };
    if (path.endsWith('/permissionscheme')) return { id: 20 };
    if (path.endsWith('/notificationscheme')) throw new Error('Jira responded 404 for /rest/api/2/project/TEST/notificationscheme');
    throw new Error('unexpected ' + path);
  },
} as any;

describe('Importing Jira permission and notification schemes', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let project: { id: number; key: string };

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const [p] = await db.select().from(schema.projects).limit(1);
    project = { id: p.id, key: p.projectKey };
    void seeded;
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('creates both schemes, assigns them, folds duplicates and reports what it left out', async () => {
    const warnings: string[] = [];
    const r = await importSchemes(client, new Resolver(appDb), [project], warnings);
    expect(r).toEqual({ permissionSchemes: 1, permissionEntries: 4, notificationSchemes: 1, assigned: 1 });

    const [scheme] = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, 'Jira dev scheme'));
    const entries = await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, scheme.id));
    expect(entries.length).toBe(4);
    expect(entries.find((e) => e.permissionKey === 'BROWSE_PROJECTS')?.anonymous).toBe(true);
    expect(entries.find((e) => e.permissionKey === 'ASSIGN_ISSUES')?.projectLead).toBe(true);
    const [assoc] = await db.select().from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, project.id));
    expect(assoc.schemeId).toBe(scheme.id);

    const [ns] = await db.select().from(schema.notificationSchemes).where(eq(schema.notificationSchemes.name, 'Jira notifications'));
    expect(ns.projectId).toBe(project.id);
    const ev = await db.select().from(schema.notificationSchemeEvents).where(eq(schema.notificationSchemeEvents.schemeId, ns.id));
    expect(ev.find((e) => e.eventType === 'issue.created')).toMatchObject({ notifyAssignee: true, notifyReporter: true });
    expect(ev.find((e) => e.eventType === 'comment.added')).toMatchObject({ notifyWatchers: true });

    expect(warnings.some((w) => w.includes('VIEW_DEV_TOOLS') || w.includes('Permissions without a counterpart'))).toBe(true);
    expect(warnings.some((w) => w.includes('reporter'))).toBe(true);
    expect(warnings.some((w) => w.includes('Group'))).toBe(true);
  });

  test('running it again duplicates nothing', async () => {
    const warnings: string[] = [];
    const r = await importSchemes(client, new Resolver(appDb), [project], warnings);
    expect(r.permissionSchemes).toBe(0);
    expect(r.notificationSchemes).toBe(0);
    const all = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, 'Jira dev scheme'));
    expect(all.length).toBe(1);
  });

  test('Data Center: roles by id and the project lead come across, a missing endpoint is explained', async () => {
    const warnings: string[] = [];
    const r = await importSchemes(dcClient, new Resolver(appDb), [project], warnings);
    expect(r.permissionSchemes).toBe(1);
    expect(r.permissionEntries).toBe(2);
    const [scheme] = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, 'DC scheme'));
    const entries = await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, scheme.id));
    expect(entries.find((e) => e.permissionKey === 'ASSIGN_ISSUES')?.projectLead).toBe(true);
    const [role] = await db.select().from(schema.projectRoles).where(eq(schema.projectRoles.name, 'DC Developers'));
    expect(entries.find((e) => e.permissionKey === 'EDIT_ISSUES')?.projectRoleId).toBe(role.id);
    expect(warnings.some((w) => w.includes('does not offer it over the REST API'))).toBe(true);
    expect(warnings.some((w) => w.includes('a user that does not exist here'))).toBe(true);
  });

  test('without admin rights the import carries on and says why', async () => {
    const warnings: string[] = [];
    const denied = { get: async () => { throw new Error('403 Forbidden'); } } as any;
    const r = await importSchemes(denied, new Resolver(appDb), [project], warnings);
    expect(r.permissionSchemes + r.notificationSchemes + r.assigned).toBe(0);
    expect(warnings.some((w) => w.includes('Administer Jira'))).toBe(true);
  });
});
