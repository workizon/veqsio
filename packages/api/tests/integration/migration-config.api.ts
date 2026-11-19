import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { and, eq } from 'drizzle-orm';
import { Resolver } from '../../src/migration/resolver';
import { db as appDb } from '../../src/db';
import { syncCustomFields, applyFieldMeta, loadFieldRefs } from '../../src/migration/rest/fieldsync';
import { fetchFieldMeta } from '../../src/migration/rest/fieldmeta';
import { importGlobalConfig, importProjectIssueTypes } from '../../src/migration/rest/config';
import { importPeople, importUserGlobalPermissions, previewPeople } from '../../src/migration/rest/people';
import { importRequiredFlags } from '../../src/migration/rest/fieldsync';
import { importScreens } from '../../src/migration/rest/screens';
import { copyUserAvatars } from '../../src/migration/rest/avatars';

const fields = [
  { id: 'customfield_10001', name: 'Customer impact', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
  { id: 'customfield_10002', name: 'Region', custom: true, schema: { type: 'option-with-child', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect' } },
  { id: 'customfield_10003', name: 'Budget', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10004', name: 'Rank', custom: true, schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
];

// Jira Cloud: the field context API
const cloud: any = {
  get: async (path: string, params: Record<string, any> = {}) => {
    if (path === '/rest/api/2/project') return [{ id: '100', key: 'TEST' }, { id: '101', key: 'GONE' }];
    if (path === '/rest/api/2/issuetype') return [{ id: '1', name: 'Bug', subtask: false, description: 'A defect' }, { id: '2', name: 'Epic Story', subtask: false }, { id: '3', name: 'Checklist item', subtask: true }];
    if (path === '/rest/api/2/field/customfield_10001/context') return { values: [{ id: '5', isGlobalContext: true, isAnyIssueType: true }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10001/context/5/option') return { values: [{ id: '51', value: 'Low' }, { id: '52', value: 'High' }, { id: '53', value: 'Retired', disabled: true }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10001/context/defaultValue') return { values: [{ contextId: '5', optionId: '52' }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10002/context') return { values: [{ id: '6', isGlobalContext: false, isAnyIssueType: false }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10002/context/projectmapping') return { values: [{ contextId: '6', projectId: '100' }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10002/context/issuetypemapping') return { values: [{ contextId: '6', issueTypeId: '1' }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10002/context/6/option') return { values: [{ id: '61', value: 'Europe' }, { id: '62', value: 'Berlin', optionId: '61' }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10002/context/defaultValue') return { values: [], isLast: true };
    if (path === '/rest/api/2/field/customfield_10003/context') return { values: [{ id: '7', isGlobalContext: false, isAnyIssueType: true }], isLast: true };
    if (path === '/rest/api/2/field/customfield_10003/context/projectmapping') return { values: [{ contextId: '7', projectId: '101' }], isLast: true }; // a project that is not imported
    if (path === '/rest/api/2/field/customfield_10003/context/defaultValue') return { values: [], isLast: true };
    if (path === '/rest/api/2/priority') return [{ name: 'Blocker', statusColor: '#ff0000' }, { name: 'Minor', statusColor: 'bad' }];
    if (path === '/rest/api/2/status') return [{ name: 'Waiting for QA', statusCategory: { key: 'indeterminate' } }, { name: 'Shipped', statusCategory: { key: 'done' } }];
    if (path === '/rest/api/2/resolution') return [{ name: "Won't Fix" }];
    if (path === '/rest/api/2/issueLinkType') return { issueLinkTypes: [{ name: 'Causes', inward: 'is caused by', outward: 'causes' }] };
    if (path === '/rest/api/2/users/search') return params.startAt ? [] : [
      { accountId: 'a1', accountType: 'atlassian', displayName: 'Ann Admin', emailAddress: 'ann@example.com', active: true },
      { accountId: 'a2', accountType: 'atlassian', displayName: 'Old Bob', active: false },
      { accountId: 'app1', accountType: 'app', displayName: 'Some Bot' },
    ];
    if (path === '/rest/api/2/group/bulk') return { values: [{ name: 'jira-administrators' }, { name: 'developers' }, { name: 'atlassian-addons-admin' }], isLast: true };
    if (path === '/rest/api/2/group/member') return { values: params.groupname === 'developers' ? [{ accountId: 'a1', displayName: 'Ann Admin', emailAddress: 'ann@example.com' }, { accountId: 'a2', displayName: 'Old Bob' }] : [{ accountId: 'a1', displayName: 'Ann Admin', emailAddress: 'ann@example.com' }], isLast: true };
    if (path === '/rest/api/2/project/TEST/role') return { Developers: 'https://jira.example.com/rest/api/2/project/100/role/10002' };
    if (path === '/rest/api/2/project/100/role/10002') return { actors: [{ type: 'atlassian-user-role-actor', actorUser: { accountId: 'a1' }, displayName: 'Ann Admin' }, { type: 'atlassian-group-role-actor', actorGroup: { name: 'developers' } }] };
    throw new Error('unexpected ' + path);
  },
};

// Jira Data Center: no field context API, people by login, groups by picker
const dc: any = {
  get: async (path: string, params: Record<string, any> = {}) => {
    if (path === '/rest/api/2/project') return [{ id: '100', key: 'TEST' }];
    if (path === '/rest/api/2/issuetype') return [];
    if (path.startsWith('/rest/api/2/field/')) throw new Error('Jira responded 404 for ' + path);
    if (path === '/rest/api/2/issue/createmeta') return { projects: [{ key: 'TEST', issuetypes: [{ name: 'Bug', fields: { customfield_20001: { allowedValues: [{ value: 'DC one' }, { value: 'DC two' }] } } }] }] };
    if (path === '/rest/api/2/users/search') throw new Error('Jira responded 404');
    if (path === '/rest/api/2/user/search') return params.startAt ? [] : [{ name: 'dcuser', key: 'JIRAUSER1', displayName: 'DC User', emailAddress: 'dc@example.com', active: true }];
    if (path === '/rest/api/2/group/bulk') throw new Error('Jira responded 404');
    if (path === '/rest/api/2/groups/picker') return { groups: [{ name: 'dc-team' }] };
    if (path === '/rest/api/2/group/member') return { values: [{ name: 'dcuser', key: 'JIRAUSER1', displayName: 'DC User', emailAddress: 'dc@example.com' }], isLast: true };
    throw new Error('unexpected ' + path);
  },
};

describe('Importing the configuration of a Jira', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let project: { id: number; key: string };
  const warnings: string[] = [];

  beforeAll(async () => {
    testSql = createTestSql();
    await seedTestData(testSql);
    db = createTestDb(testSql);
    const [p] = await db.select().from(schema.projects).limit(1);
    // the test project plays the part of TEST
    await db.update(schema.projects).set({ projectKey: 'TEST' }).where(eq(schema.projects.id, p.id));
    project = { id: p.id, key: 'TEST' };
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  test('issue types, priorities, statuses, resolutions and link types of the instance', async () => {
    const r = await importGlobalConfig(cloud, warnings);
    expect(r.issueTypes.created).toBeGreaterThanOrEqual(2);
    const sub = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.name, 'Checklist item'));
    expect(sub[0].isSubtask).toBe(true);
    const [bug] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.name, 'Epic Story'));
    expect(bug).toBeDefined();
    const [blocker] = await db.select().from(schema.priorities).where(eq(schema.priorities.name, 'Blocker'));
    expect(blocker.color).toBe('#ff0000');
    const [minor] = await db.select().from(schema.priorities).where(eq(schema.priorities.name, 'Minor'));
    expect(minor.sortOrder).toBeGreaterThan(blocker.sortOrder!);
    const [qa] = await db.select().from(schema.statuses).where(eq(schema.statuses.name, 'Waiting for QA'));
    expect(qa.category).toBe('in_progress');
    expect((await db.select().from(schema.resolutions).where(eq(schema.resolutions.name, "Won't Fix"))).length).toBe(1);
    expect((await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.name, 'Causes')))[0].outward).toBe('causes');
    // again: nothing is duplicated
    const again = await importGlobalConfig(cloud, warnings);
    expect(again.issueTypes.created + again.priorities.created + again.statuses.created + again.resolutions.created + again.linkTypes.created).toBe(0);
  });

  test('the issue types a project offers become a scheme, shared by projects with the same set', async () => {
    const report = await importGlobalConfig(cloud, []);
    await importProjectIssueTypes({ issueTypes: [{ name: 'Bug' }, { name: 'Epic Story' }] }, project.id, report, warnings);
    const [assoc] = await db.select().from(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, project.id));
    const items = await db.select().from(schema.issueTypeSchemeItems).where(eq(schema.issueTypeSchemeItems.schemeId, assoc.schemeId));
    expect(items.length).toBe(2);
  });

  test('custom fields: created, remembered by Jira id, with contexts, options and defaults; skipped ones are listed', async () => {
    const w: string[] = [];
    const synced = await syncCustomFields(fields as any, w);
    expect(synced.report.created.map((c) => c.name).sort()).toEqual(['Budget', 'Customer impact', 'Region']);
    expect(synced.report.skipped.map((s) => s.jiraName)).toEqual(['Rank']);
    const refs = await loadFieldRefs();
    expect(refs.has('customfield_10001')).toBe(true);

    const metas = await fetchFieldMeta(cloud, synced.bindings.map((b) => b.jiraId), ['TEST'], w);
    await applyFieldMeta(synced.bindings, synced.createdIds, metas, synced.report, w);

    const bind = (id: string) => synced.bindings.find((b) => b.jiraId === id)!.veqsioId;
    const impactCtx = await db.select().from(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, bind('customfield_10001')));
    expect(impactCtx).toHaveLength(1);
    expect([impactCtx[0].projectId, impactCtx[0].issueTypeId]).toEqual([null, null]);
    const impactOpts = await db.select().from(schema.customFieldOptions).where(eq(schema.customFieldOptions.customFieldId, bind('customfield_10001'))).orderBy(schema.customFieldOptions.sortOrder);
    expect(impactOpts.map((o) => [o.value, o.archived])).toEqual([['Low', false], ['High', false], ['Retired', true]]);
    const [impact] = await db.select().from(schema.customFields).where(eq(schema.customFields.id, bind('customfield_10001')));
    expect(impact.defaultValue).toBe('High');

    const regionCtx = await db.select().from(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, bind('customfield_10002')));
    expect(regionCtx).toHaveLength(1);
    expect(regionCtx[0].projectId).toBe(project.id);
    const regionOpts = await db.select().from(schema.customFieldOptions).where(eq(schema.customFieldOptions.customFieldId, bind('customfield_10002'))).orderBy(schema.customFieldOptions.sortOrder);
    expect(regionOpts.map((o) => o.value)).toEqual(['Europe', 'Europe / Berlin']);

    // a field limited to a project that is not imported: no context, and the person is told
    expect(await db.select().from(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, bind('customfield_10003')))).toHaveLength(0);
    expect(w.some((x) => x.includes('Budget') && x.includes('not imported'))).toBe(true);
    expect(synced.report.contexts).toBe(2);
    expect(synced.report.options).toBe(5);
  });

  test('importing again maps by the remembered Jira id and adds nothing twice', async () => {
    const w: string[] = [];
    const before = (await db.select().from(schema.customFields)).length;
    const synced = await syncCustomFields(fields as any, w);
    expect(synced.report.created).toHaveLength(0);
    expect(synced.report.matched.every((m) => m.by === 'id')).toBe(true);
    expect((await db.select().from(schema.customFields)).length).toBe(before);
    const metas = await fetchFieldMeta(cloud, synced.bindings.map((b) => b.jiraId), ['TEST'], w);
    await applyFieldMeta(synced.bindings, synced.createdIds, metas, synced.report, w);
    expect(synced.report.options).toBe(0);
  });

  test('Data Center: contexts and options come from the create metadata', async () => {
    const w: string[] = [];
    const dcFields = [{ id: 'customfield_20001', name: 'DC impact', custom: true, schema: { type: 'option' } }];
    const synced = await syncCustomFields(dcFields as any, w);
    expect(synced.report.created[0].name).toBe('DC impact');
    const metas = await fetchFieldMeta(dc, ['customfield_20001'], ['TEST'], w);
    expect(metas.get('customfield_20001')?.source).toBe('createmeta');
    await applyFieldMeta(synced.bindings, synced.createdIds, metas, synced.report, w);
    const id = synced.bindings[0].veqsioId;
    const ctx = await db.select().from(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, id));
    expect(ctx).toHaveLength(1);                       // present for every type of every project: one global context
    expect([ctx[0].projectId, ctx[0].issueTypeId]).toEqual([null, null]);
    const opts = await db.select().from(schema.customFieldOptions).where(eq(schema.customFieldOptions.customFieldId, id)).orderBy(schema.customFieldOptions.sortOrder);
    expect(opts.map((o) => o.value)).toEqual(['DC one', 'DC two']);
  });

  test('people: users matched or created, groups with members, project roles, administrators', async () => {
    const w: string[] = [];
    const resolver = new Resolver(appDb);
    const acc = await importPeople(cloud, resolver, [], w, 'accounts');
    expect(acc.users.created).toBe(2);      // the app account is not a person
    expect(acc.users.inactive).toBe(1);
    expect(acc.users.withoutEmail).toBe(1);
    expect(acc.groups.created).toBe(2);     // jira-administrators and developers, not the Atlassian one
    expect(acc.adminGroups).toEqual(['jira-administrators']);
    const [bob] = await db.select().from(schema.users).where(eq(schema.users.displayName, 'Old Bob'));
    expect(bob.active).toBe(false);
    expect(bob.email.endsWith('@migrated.invalid')).toBe(true);
    const [ann] = await db.select().from(schema.users).where(eq(schema.users.email, 'ann@example.com'));
    const [devs] = await db.select().from(schema.groups).where(eq(schema.groups.name, 'developers'));
    expect((await db.select().from(schema.userGroups).where(and(eq(schema.userGroups.userId, ann.id), eq(schema.userGroups.groupId, devs.id)))).length).toBe(1);
    const [admins] = await db.select().from(schema.groups).where(eq(schema.groups.name, 'jira-administrators'));
    const adminEntry = await db.select().from(schema.permissionEntries).where(and(eq(schema.permissionEntries.groupId, admins.id), eq(schema.permissionEntries.permissionKey, 'ADMINISTER')));
    expect(adminEntry).toHaveLength(1);

    const roles = await importPeople(cloud, resolver, [project], w, 'roles');
    expect(roles.roleActors).toBe(2);
    const actors = await db.select().from(schema.projectRoleActors).where(eq(schema.projectRoleActors.projectId, project.id));
    expect(actors.some((a) => a.userId === ann.id)).toBe(true);
    expect(actors.some((a) => a.groupId === devs.id)).toBe(true);

    // a second run matches the same people and adds nothing
    const again = await importPeople(cloud, new Resolver(appDb), [project], w, 'all');
    expect(again.users.created).toBe(0);
    expect(again.roleActors).toBe(0);
  });

  test('people from Data Center: users by login, groups from the picker', async () => {
    const w: string[] = [];
    const r = await importPeople(dc, new Resolver(appDb), [], w, 'accounts');
    expect(r.users.created).toBe(1);
    expect(r.groups.created).toBe(1);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'dc@example.com'));
    expect(u.username).toBe('dcuser');
  });


  test('required fields: a field configuration per distinct set, assigned to the project and issue type', async () => {
    const w: string[] = [];
    const [bug] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.name, 'Bug'));
    const synced = await syncCustomFields([{ id: 'customfield_30001', name: 'Needs sign-off', custom: true, schema: { type: 'string' } }] as any, w);
    const meta: any = { get: async (p: string) => {
      if (p === '/rest/api/2/issue/createmeta') return { projects: [{ key: 'TEST', issuetypes: [{ name: 'Bug', fields: { customfield_30001: { required: true } } }, { name: 'Epic Story', fields: { customfield_30001: { required: false } } }] }] };
      throw new Error('unexpected ' + p);
    } };
    const report: any = { created: [], matched: [], skipped: [], contexts: 0, options: 0 };
    await importRequiredFlags(meta, synced.bindings, [project], report, w);
    expect(report.requiredConfigs).toBe(1);
    const [assoc] = await db.select().from(schema.fieldConfigurationSchemeAssociations).where(and(eq(schema.fieldConfigurationSchemeAssociations.projectId, project.id), eq(schema.fieldConfigurationSchemeAssociations.issueTypeId, bug.id)));
    const items = await db.select().from(schema.fieldConfigurationItems).where(eq(schema.fieldConfigurationItems.configId, assoc.configId));
    expect(items).toHaveLength(1);
    expect([items[0].fieldId, items[0].isRequired, items[0].isCustomField]).toEqual([synced.bindings[0].veqsioId, true, true]);
    // again: the pair already has a configuration, which is left alone
    const again: any = { created: [], matched: [], skipped: [], contexts: 0, options: 0 };
    await importRequiredFlags(meta, synced.bindings, [project], again, w);
    expect(again.requiredConfigs ?? 0).toBe(0);
    expect(w.some((x) => x.includes('already have a field configuration'))).toBe(true);
  });

  test('screens: tabs and fields, system and custom, and the Jira id for the transitions', async () => {
    const w: string[] = [];
    const synced = await syncCustomFields([{ id: 'customfield_30002', name: 'Review notes', custom: true, schema: { type: 'string' } }] as any, w);
    const jira: any = { get: async (p: string) => {
      if (p === '/rest/api/2/screens') return { values: [{ id: '501', name: 'Resolve screen' }], isLast: true };
      if (p === '/rest/api/2/screens/501/tabs') return [{ id: '1', name: 'Field Tab' }];
      if (p === '/rest/api/2/screens/501/tabs/1/fields') return [{ id: 'resolution' }, { id: 'assignee' }, { id: 'summary' }, { id: 'customfield_30002' }];
      throw new Error('unexpected ' + p);
    } };
    const r = await importScreens(jira, synced.bindings, [], w);
    expect(r.report).toMatchObject({ created: 1, fields: 3, skippedFields: 1 });
    const screenId = r.byJiraId.get('501')!;
    const [tab] = await db.select().from(schema.screenTabs).where(eq(schema.screenTabs.screenId, screenId));
    const fields = await db.select().from(schema.screenTabFields).where(eq(schema.screenTabFields.tabId, tab.id)).orderBy(schema.screenTabFields.sortOrder);
    expect(fields.map((f) => f.fieldKey ?? `custom:${f.fieldId}`)).toEqual(['resolution', 'assignee', `custom:${synced.bindings[0].veqsioId}`]);
    // again: matched, not duplicated
    expect((await importScreens(jira, synced.bindings, [], w)).report).toMatchObject({ created: 0, matched: 1 });
    // Data Center has no screens API
    const w2: string[] = [];
    const dcScreens = await importScreens({ get: async () => { throw new Error('Jira responded 404'); } } as any, [], [], w2);
    expect(dcScreens.report.created).toBe(0);
    expect(w2.some((x) => x.includes('Screens not imported'))).toBe(true);
  });

  test('avatars: copied for people who have none, the rest left alone', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const [u] = await db.insert(schema.users).values({ username: 'pic', email: 'pic@example.com', displayName: 'Pic' }).returning();
    const [hasOne] = await db.insert(schema.users).values({ username: 'haspic', email: 'haspic@example.com', displayName: 'Has', avatarUrl: 'https://example.com/mine.png' }).returning();
    const client: any = { baseUrl: 'https://jira.example.com', download: async () => png };
    const rep = { users: 0, projects: 0, failed: 0 };
    await copyUserAvatars(client, new Map([[u.id, 'https://jira.example.com/secure/useravatar?avatarId=1'], [hasOne.id, 'https://jira.example.com/secure/useravatar?avatarId=2']]), rep);
    expect(rep).toEqual({ users: 1, projects: 0, failed: 0 });
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.avatarUrl).toContain('/attachments/users/avatars/');
    expect((await db.select().from(schema.users).where(eq(schema.users.id, hasOne.id)))[0].avatarUrl).toBe('https://example.com/mine.png');
  });

  test('global permissions of single people: written for those who hold them, not for what nearly everybody holds', async () => {
    const people = [] as Array<{ accountId: string; id: number }>;
    for (let i = 0; i < 12; i++) {
      const [u] = await db.insert(schema.users).values({ username: `gp${i}`, email: `gp${i}@example.com`, displayName: `GP ${i}` }).returning();
      people.push({ accountId: `acc${i}`, id: u.id });
    }
    const jira: any = { post: async (_p: string, body: any) => ({ globalPermissions: [...(body.accountId === 'acc3' ? ['CREATE_PROJECT'] : []), 'BROWSE_USERS'] }) };
    const w: string[] = [];
    const r = await importUserGlobalPermissions(jira, people, w);
    expect(r.checked).toBe(12);
    expect(r.entries).toBe(1);                                   // only acc3's CREATE_PROJECT; BROWSE_USERS is everybody's
    expect(w.some((x) => x.includes('BROWSE_USERS') && x.includes('nearly everybody'))).toBe(true);
    const entry = await db.select().from(schema.permissionEntries).where(and(eq(schema.permissionEntries.permissionKey, 'CREATE_PROJECT'), eq(schema.permissionEntries.userId, people[3].id)));
    expect(entry).toHaveLength(1);
    // Data Center: no such API, one warning and nothing written
    const w2: string[] = [];
    const dcRes = await importUserGlobalPermissions({ post: async () => { throw new Error('Jira responded 404'); } } as any, people, w2);
    expect(dcRes).toEqual({ checked: 0, entries: 0 });
    expect(w2).toHaveLength(1);
  });

  test('the people preview says who matches and who would be created, and writes nothing', async () => {
    const before = (await db.select().from(schema.users)).length;
    await db.insert(schema.users).values({ username: 'ann-here', email: 'ann@preview.example', displayName: 'Ann Here' }).onConflictDoNothing();
    const jira: any = { get: async (p: string, params: any = {}) => {
      if (p === '/rest/api/2/users/search') return params.startAt ? [] : [
        { accountId: 'p1', accountType: 'atlassian', displayName: 'Ann Here', emailAddress: 'ann@preview.example', active: true },
        { accountId: 'p2', accountType: 'atlassian', displayName: 'New Person', emailAddress: 'new@preview.example', active: true },
        { accountId: 'p3', accountType: 'atlassian', displayName: 'Hidden', active: false },
      ];
      if (p === '/rest/api/2/group/bulk') return { values: [{ name: 'jira-administrators' }, { name: 'developers' }], isLast: true };
      throw new Error('unexpected ' + p);
    } };
    const prev = await previewPeople(jira, new Resolver(appDb));
    expect(prev.users).toMatchObject({ total: 3, willMatch: 1, willCreate: 2, inactive: 1, withoutEmail: 1 });
    expect(prev.sample.find((x) => x.displayName === 'Ann Here')).toMatchObject({ status: 'match', matchedTo: 'ann-here' });
    expect(prev.groups.administrators).toEqual(['jira-administrators']);
    expect((await db.select().from(schema.users)).length).toBe(before + 1);   // only the account this test added
  });

  test('without administrator rights the import carries on and says why', async () => {
    const w: string[] = [];
    const denied: any = { get: async () => { throw new Error('Jira responded 403 for /rest/api/2/users/search'); } };
    const r = await importPeople(denied, new Resolver(appDb), [], w, 'accounts');
    expect(r.users.created).toBe(0);
    expect(w.some((x) => x.includes('Administer Jira'))).toBe(true);
  });
});
