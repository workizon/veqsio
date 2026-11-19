import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and, isNull } from 'drizzle-orm';
import { JiraClient, normalizeBaseUrl } from '../../src/migration/rest/client';
import { runRestImport } from '../../src/migration/rest/importer';

const user = (n: string) => ({ name: n, emailAddress: `${n}@corp.example`, displayName: n.toUpperCase() });
const issue = (num: number, extra: any = {}) => ({
  id: String(1000 + num), key: `ABC-${num}`,
  fields: {
    summary: `Issue ${num}`, description: `desc ${num}`,
    issuetype: { name: 'Bug', subtask: false },
    status: { name: 'Done', statusCategory: { key: 'done' } },
    priority: { name: 'High' }, resolution: { name: 'Fixed' },
    assignee: user('bob'), reporter: user('alice'),
    created: '2020-01-02T10:00:00.000+0000', updated: '2020-02-03T10:00:00.000+0000', resolutiondate: '2020-02-03T10:00:00.000+0000',
    labels: ['x'], components: [{ name: 'Core' }], fixVersions: [{ name: '1.0' }], versions: [],
    comment: { total: 2, comments: [
      { body: 'public', author: user('bob'), created: '2020-01-03T10:00:00.000+0000' },
      { body: 'private', author: user('bob'), created: '2020-01-04T10:00:00.000+0000', visibility: { type: 'role', value: 'Developers' } },
    ] },
    worklog: { total: 1, worklogs: [{ author: user('bob'), timeSpentSeconds: 3600, started: '2020-01-05T10:00:00.000+0000' }] },
    attachment: [], issuelinks: [], ...extra,
  },
  changelog: { histories: [
    { created: '2020-01-10T10:00:00.000+0000', author: user('bob'), items: [{ field: 'status', fromString: 'Open', toString: 'In Progress' }] },
    { created: '2020-02-03T10:00:00.000+0000', author: user('bob'), items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
  ] },
});

const FIELD_META = [
  { id: 'customfield_10001', name: 'Severity', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
  { id: 'customfield_10002', name: 'Story Points', custom: true, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
  { id: 'customfield_10003', name: 'Customers', custom: true, schema: { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect' } },
  { id: 'customfield_10004', name: 'Rank', custom: true, schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
  { id: 'customfield_10005', name: 'Reviewer', custom: true, schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } },
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
];

const ISSUES = [
  issue(1, {
    customfield_10001: { value: 'Critical' }, customfield_10002: 8, customfield_10003: [{ value: 'ACME' }, { value: 'Globex' }],
    customfield_10004: '0|abc', customfield_10005: user('carol'), issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ABC-7' } }] }),
  issue(7, { issuetype: { name: 'Sub-task', subtask: true }, parent: { key: 'ABC-1' } }),
];

function fakeJira(): typeof fetch {
  return (async (input: any, init: any) => {
    const u = new URL(String(input));
    expect(init.headers.Authorization).toStartWith('Basic ');
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/rest/api/2/project/ABC') {
      return json({ key: 'ABC', name: 'Alpha', lead: user('alice'), components: [{ name: 'Core' }, { name: 'UI' }], versions: [{ name: '1.0', released: true }] });
    }
    if (u.pathname === '/rest/api/2/search') {
      const max = Number(u.searchParams.get('maxResults'));
      const start = Number(u.searchParams.get('startAt') || 0);
      return json({ total: ISSUES.length, issues: max === 0 ? [] : ISSUES.slice(start, start + max) });
    }
    if (u.pathname === '/rest/api/2/field') return json(FIELD_META);
    if (u.pathname === '/rest/api/2/status') return json([{ id: '1', name: 'Open' }, { id: '2', name: 'Done' }]);
    if (u.pathname === '/rest/agile/1.0/board') return json({ isLast: true, values: [{ id: 5, name: 'ABC board', type: 'scrum' }] });
    if (u.pathname === '/rest/agile/1.0/board/5/configuration') {
      return json({ columnConfig: { columns: [{ name: 'Backlog', statuses: [{ id: '1' }] }, { name: 'Finished', statuses: [{ id: '2' }], max: 3 }] } });
    }
    if (u.pathname === '/rest/agile/1.0/board/5/sprint') {
      return json({ isLast: true, values: [{ id: 9, name: 'Sprint A', state: 'closed', startDate: '2020-01-01T00:00:00.000Z', endDate: '2020-01-14T00:00:00.000Z', completeDate: '2020-01-14T00:00:00.000Z' }] });
    }
    if (u.pathname === '/rest/agile/1.0/sprint/9/issue') return json({ isLast: true, values: [{ key: 'ABC-1' }, { key: 'ABC-7' }, { key: 'ZZZ-1' }] });
    return json({ errorMessages: ['nope'] }, 404);
  }) as any;
}

describe('Jira REST import', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let seeded: any;
  const client = () => new JiraClient({ baseUrl: 'https://jira.corp.example', auth: { type: 'basic', username: 'a', secret: 'b' }, fetchImpl: fakeJira(), sleep: async () => {} });

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
  });
  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('imports project, issues, comments, worklogs, links, parent and history', async () => {
    const report = await runRestImport(client(), { projectKeys: ['ABC'] }, seeded.user.id);
    expect(report.errors).toEqual([]);
    expect(report.projects.ABC).toMatchObject({ total: 2, created: 2, comments: 4, worklogs: 2, links: 1, workflows: 2, transitions: 14 });

    const db = createTestDb(testSql);
    const [i1] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'ABC-1'));
    const [i7] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, 'ABC-7'));
    expect(i1.createdAt?.toISOString()).toBe('2020-01-02T10:00:00.000Z');
    expect(i7.parentId).toBe(i1.id);

    const comments = await db.select().from(schema.comments).where(eq(schema.comments.issueId, i1.id));
    expect(comments.find((c) => c.body === 'private')?.isInternal).toBe(true);
    expect(comments.find((c) => c.body === 'public')?.isInternal).toBe(false);

    const hist = await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, i1.id));
    expect(hist).toHaveLength(2);
    expect(hist.find((h) => h.newValue === 'Done')).toMatchObject({ fieldName: 'status', oldValue: 'In Progress' });

    // Key generator continues after the highest imported number.
    const [counter] = await db.select().from(schema.projectIssueCounters).where(eq(schema.projectIssueCounters.projectId, i1.projectId));
    expect(counter.currentValue).toBe(7);
    expect(report.usersCreated).toBe(3); // alice, bob and the Reviewer custom field user (carol)

    // Custom fields: created by name, Jira plumbing fields skipped, values converted
    const fields = await db.select().from(schema.customFields);
    expect(fields.map((f) => f.name).sort()).toEqual(['Customers', 'Reviewer', 'Severity']); // Story Points is first-class (issues.story_points), not a custom field
    expect(report.projects.ABC.customValues).toBe(3); // Severity, Customers, Reviewer (Rank is skipped)
    expect(Number(i1.storyPoints)).toBe(8);
    const vals = await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.issueId, i1.id));
    const by = (name: string) => vals.find((v) => v.customFieldId === fields.find((f) => f.name === name)!.id)!;
    expect(by('Severity').stringValue).toBe('Critical');
    expect(by('Customers').stringValue).toBe('ACME, Globex');
    expect(by('Reviewer').userValue).not.toBeNull();

    // Boards, columns and sprints
    expect(report.projects.ABC).toMatchObject({ boards: 1, sprints: 1, sprintIssues: 2 });
    const [board] = await db.select().from(schema.boards);
    expect(board).toMatchObject({ name: 'ABC board', type: 'scrum' });
    const cols = await db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, board.id));
    expect(cols.map((c) => c.name).sort()).toEqual(['Backlog', 'Finished']);
    expect(cols.find((c) => c.name === 'Finished')?.max).toBe(3);
    const [sprint] = await db.select().from(schema.sprints);
    expect(sprint).toMatchObject({ name: 'Sprint A', state: 'closed' });
  });

  test('creates inferred workflows, transitions, scheme items and the project association', async () => {
    const db = createTestDb(testSql);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'ABC'));
    const wfs = await db.select().from(schema.workflows);
    const bug = wfs.find((w) => w.name === 'ABC Bug workflow (imported)')!;
    const sub = wfs.find((w) => w.name === 'ABC Sub-task workflow (imported)')!;
    expect(bug).toBeDefined();
    expect(sub).toBeDefined();
    expect(bug.isDefault).toBe(false);

    const statuses = await db.select().from(schema.statuses);
    const sid = (n: string) => statuses.find((s) => s.name === n)!.id;
    const trs = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, bug.id));
    // initial + Open>In Progress + In Progress>Done observed; Done is terminal so all 6 pairs get connected
    expect(trs).toHaveLength(7);
    const initial = trs.filter((t) => t.fromStatusId === null);
    expect(initial).toHaveLength(1);
    expect(initial[0].toStatusId).toBe(sid('Open'));
    const has = (a: string, b: string) => trs.some((t) => t.fromStatusId === sid(a) && t.toStatusId === sid(b));
    expect(has('Open', 'In Progress')).toBe(true);
    expect(has('In Progress', 'Done')).toBe(true);
    expect(has('Done', 'Open')).toBe(true); // reopen path so imported Done issues are not stuck
    expect(trs.find((t) => t.fromStatusId === sid('Open') && t.toStatusId === sid('In Progress'))!.name).toBe('To In Progress');
    expect(new Set(trs.map((t) => t.name)).size).toBe(trs.length);

    const [assoc] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, project.id));
    const [scheme] = await db.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, assoc.schemeId));
    expect(scheme.name).toBe('ABC workflow scheme (imported)');
    const items = await db.select().from(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.schemeId, scheme.id));
    const types = await db.select().from(schema.issueTypes);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.issueTypeId === types.find((t) => t.name === 'Bug')!.id)!.workflowId).toBe(bug.id);
    expect(items.find((i) => i.issueTypeId === types.find((t) => t.name === 'Sub-task')!.id)!.workflowId).toBe(sub.id);

    // the engine can find an initial transition the same way createIssue does
    const initialRows = await db.select().from(schema.workflowTransitions)
      .where(and(eq(schema.workflowTransitions.workflowId, sub.id), isNull(schema.workflowTransitions.fromStatusId)));
    expect(initialRows).toHaveLength(1);
  });

  test('re-running is idempotent (issues skipped, no duplicate comments, no duplicate workflows)', async () => {
    const report = await runRestImport(client(), { projectKeys: ['ABC'] }, seeded.user.id);
    expect(report.projects.ABC).toMatchObject({ created: 0, skipped: 2, comments: 0, links: 0, boards: 0, sprints: 0, workflows: 0, transitions: 0 });
    const dbw = createTestDb(testSql);
    const wfRows = await dbw.select().from(schema.workflows);
    const bugWf = wfRows.find((w) => w.name === 'ABC Bug workflow (imported)')!.id;
    const subWf = wfRows.find((w) => w.name === 'ABC Sub-task workflow (imported)')!.id;
    expect(await dbw.select().from(schema.workflows).where(eq(schema.workflows.name, 'ABC Bug workflow (imported)'))).toHaveLength(1);
    const seededTrs = await dbw.select().from(schema.workflowTransitions);
    expect(seededTrs.filter((t) => t.workflowId !== undefined && [bugWf, subWf].includes(t.workflowId))).toHaveLength(14);
    expect(await dbw.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.name, 'ABC workflow scheme (imported)'))).toHaveLength(1);
    const db = createTestDb(testSql);
    const all = await db.select().from(schema.comments);
    expect(all).toHaveLength(4);
  });

  test('an existing project association is never overwritten (warning instead)', async () => {
    const db = createTestDb(testSql);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'ABC'));
    const [mine] = await db.insert(schema.workflowSchemes).values({ name: 'Admin scheme' }).returning();
    await db.update(schema.workflowSchemeAssociations).set({ schemeId: mine.id }).where(eq(schema.workflowSchemeAssociations.projectId, project.id));
    const report = await runRestImport(client(), { projectKeys: ['ABC'] }, seeded.user.id);
    expect(report.warnings.some((w) => w.includes('ABC: project already uses a workflow scheme'))).toBe(true);
    const [assoc] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, project.id));
    expect(assoc.schemeId).toBe(mine.id);
  });

  test('includeWorkflows: false skips workflow creation', async () => {
    const before = await createTestDb(testSql).select().from(schema.workflows);
    const report = await runRestImport(client(), { projectKeys: ['ABC'], includeWorkflows: false }, seeded.user.id);
    expect(report.projects.ABC).toMatchObject({ workflows: 0, transitions: 0 });
    expect(await createTestDb(testSql).select().from(schema.workflows)).toHaveLength(before.length);
  });

  test('rejects unsafe Jira URLs', () => {
    expect(() => normalizeBaseUrl('http://jira.corp.example')).toThrow();
    expect(() => normalizeBaseUrl('https://user:pw@jira.corp.example')).toThrow();
    expect(() => normalizeBaseUrl('https://169.254.169.254')).toThrow();
    expect(normalizeBaseUrl('https://jira.corp.example/jira/')).toBe('https://jira.corp.example/jira');
  });

  test('client refuses to fetch attachment URLs on another host', async () => {
    await expect(client().download('https://evil.example/secret')).rejects.toThrow(/outside the configured Jira host/);
  });
});
