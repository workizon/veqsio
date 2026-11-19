import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import app from '../../src/app';
import { runDueRecurring } from '../../src/recurring/service';

describe('Templates, recurring issues, project lifecycle, terminology', () => {
  let seeded: any;
  let admin: string;
  let bob: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const A = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
  const login = async (username: string, password: string) => {
    const r = await app.request('/rest/auth/1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return r.headers.get('set-cookie') || '';
  };

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('secret123', 12);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    admin = await login('admin', 'secret123');
    bob = await login('bob', 'secret123');
  });
  afterAll(async () => { await resetTestDb(testSql); await testSql.end(); });

  let templateId: number;
  let globalId: number;

  describe('issue templates', () => {
    test('create, validate, de-duplicate and list', async () => {
      await A('POST', '/rest/api/2/project/TEST/components', { name: 'Backend' });
      const body = { projectKey: 'TEST', name: 'Bug report', issueTypeId: seeded.issueType.id, summaryPattern: 'Bug {date}', body: '## Steps\n1. ', priorityId: seeded.priority.id, labels: ['bug'], components: ['backend', 'Nope'] };
      const res = await A('POST', '/rest/api/2/issue-template', body);
      expect(res.status).toBe(201);
      templateId = (await res.json()).id;
      expect((await A('POST', '/rest/api/2/issue-template', body)).status).toBe(409);
      expect((await A('POST', '/rest/api/2/issue-template', { ...body, name: 'x', evil: 1 })).status).toBe(400); // strict
      expect((await A('POST', '/rest/api/2/issue-template', { ...body, name: 'y', issueTypeId: 99999 })).status).toBe(400);
      const g = await A('POST', '/rest/api/2/issue-template', { name: 'Global task', issueTypeId: seeded.issueType.id, summaryPattern: 'Chore' });
      expect(g.status).toBe(201);
      globalId = (await g.json()).id;
      const list = await (await A('GET', '/rest/api/2/issue-template?projectKey=TEST')).json();
      expect(list.templates.map((t: any) => t.name).sort()).toEqual(['Bug report', 'Global task']);
      expect(list.canManageProject).toBe(true);
      const onlyGlobal = await (await A('GET', '/rest/api/2/issue-template')).json();
      expect(onlyGlobal.templates.map((t: any) => t.name)).toEqual(['Global task']);
    });

    test('permissions: users without CREATE_ISSUES / admin rights cannot use or manage', async () => {
      expect((await call(bob, 'GET', '/rest/api/2/issue-template?projectKey=TEST')).status).toBe(404);
      expect((await call(bob, 'GET', `/rest/api/2/issue-template/${templateId}`)).status).toBe(404);
      expect((await call(bob, 'POST', '/rest/api/2/issue-template', { projectKey: 'TEST', name: 'Evil', issueTypeId: seeded.issueType.id })).status).toBe(403);
      expect((await call(bob, 'POST', '/rest/api/2/issue-template', { name: 'Evil global', issueTypeId: seeded.issueType.id })).status).toBe(403);
      expect((await call(bob, 'DELETE', `/rest/api/2/issue-template/${templateId}`)).status).toBe(404);
      expect((await app.request('/rest/api/2/issue-template')).status).toBe(401);
    });

    test('prefill resolves placeholders and components; creating from a template makes the issue', async () => {
      const pre = await (await A('GET', `/rest/api/2/issue-template/${templateId}/prefill?projectKey=TEST`)).json();
      expect(pre.summary).toMatch(/^Bug \d{4}-\d{2}-\d{2}$/);
      expect(pre.components.length).toBe(1); // "Nope" does not exist in the project and is skipped
      expect(pre.labels).toEqual(['bug']);
      const res = await A('POST', `/rest/api/2/issue-template/${templateId}/issue`, { projectKey: 'TEST', summary: 'Login broken' });
      expect(res.status).toBe(201);
      const issue = await (await A('GET', `/rest/api/2/issue/${(await res.json()).key}`)).json();
      expect(issue.fields.summary).toBe('Login broken');
      expect(issue.fields.description).toContain('## Steps');
      expect(issue.fields.labels).toContain('bug');
    });

    test('update and delete', async () => {
      const up = await A('PUT', `/rest/api/2/issue-template/${globalId}`, { name: 'Global chore' });
      expect(up.status).toBe(200);
      expect((await up.json()).name).toBe('Global chore');
      expect((await A('PUT', `/rest/api/2/issue-template/${globalId}`, { bogus: true })).status).toBe(400);
    });
  });

  describe('recurring issues', () => {
    let ruleId: number;
    const slotsOf = async () => (await db.select().from(schema.recurringIssueRuns).where(eq(schema.recurringIssueRuns.recurringId, ruleId))).sort((a, b) => a.slotAt.getTime() - b.slotAt.getTime());
    const issuesCount = async () => (await db.select().from(schema.issues).where(eq(schema.issues.projectId, seeded.project.id))).length;

    test('validation and permission', async () => {
      const ok = { name: 'Weekly report', templateId, frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '09:00', timezone: 'Europe/Berlin' };
      expect((await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, timezone: 'Mars/Base' })).status).toBe(400);
      expect((await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, timeOfDay: '9am' })).status).toBe(400);
      expect((await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, frequency: 'monthly' })).status).toBe(400); // needs dayOfMonth
      expect((await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, templateId: 424242 })).status).toBe(400);
      expect((await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, extra: 1 })).status).toBe(400);
      expect((await call(bob, 'POST', '/rest/api/2/project/TEST/recurring-issue', ok)).status).toBe(403);
      expect((await call(bob, 'GET', '/rest/api/2/project/TEST/recurring-issue')).status).toBe(403);
      const res = await A('POST', '/rest/api/2/project/TEST/recurring-issue', { ...ok, frequency: 'daily', daysOfWeek: [] });
      expect(res.status).toBe(201);
      const rule = await res.json();
      ruleId = rule.id;
      expect(new Date(rule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      // a template used by a rule cannot be deleted
      expect((await A('DELETE', `/rest/api/2/issue-template/${templateId}`)).status).toBe(409);
    });

    test('creates one issue per slot and is idempotent across ticks and restarts', async () => {
      const slot = new Date(Date.now() - 60_000);
      slot.setSeconds(0, 0);
      await db.update(schema.recurringIssues).set({ nextRunAt: slot }).where(eq(schema.recurringIssues.id, ruleId));
      const before = await issuesCount();
      const r1 = await runDueRecurring(new Date());
      expect(r1.created).toBe(1);
      const r2 = await runDueRecurring(new Date());
      expect(r2.created).toBe(0);
      expect(await issuesCount()).toBe(before + 1);
      // "restart": the rule is rewound to the same slot (e.g. the advance was lost); the run row prevents a duplicate
      await db.update(schema.recurringIssues).set({ nextRunAt: slot }).where(eq(schema.recurringIssues.id, ruleId));
      const r3 = await runDueRecurring(new Date());
      expect(r3.created).toBe(0);
      expect(await issuesCount()).toBe(before + 1);
      const runs = await slotsOf();
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('created');
      expect(runs[0].issueKey).toMatch(/^TEST-/);
      const [rule] = await db.select().from(schema.recurringIssues).where(eq(schema.recurringIssues.id, ruleId));
      expect(rule.lastRunAt?.getTime()).toBe(slot.getTime());
      expect(rule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      const log = await (await A('GET', `/rest/api/2/project/TEST/recurring-issue/${ruleId}/runs`)).json();
      expect(log.runs[0].status).toBe('created');
    });

    test('after downtime only the latest missed slot creates an issue', async () => {
      await db.delete(schema.recurringIssueRuns).where(eq(schema.recurringIssueRuns.recurringId, ruleId));
      const start = new Date(Date.now() - 3 * 86400_000);
      start.setSeconds(0, 0);
      await db.update(schema.recurringIssues).set({ nextRunAt: start }).where(eq(schema.recurringIssues.id, ruleId));
      const before = await issuesCount();
      const r = await runDueRecurring(new Date());
      expect(r.created).toBe(1);
      expect(r.skipped).toBeGreaterThanOrEqual(2);
      expect(await issuesCount()).toBe(before + 1);
      const runs = await slotsOf();
      expect(runs.filter((x) => x.status === 'created').length).toBe(1);
      expect(runs[runs.length - 1].status).toBe('created');
    });

    test('paused rules do not run; resuming starts from now', async () => {
      expect((await A('PUT', `/rest/api/2/project/TEST/recurring-issue/${ruleId}`, { active: false })).status).toBe(200);
      await db.update(schema.recurringIssues).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.recurringIssues.id, ruleId));
      const before = await issuesCount();
      expect((await runDueRecurring(new Date())).created).toBe(0);
      expect(await issuesCount()).toBe(before);
      const res = await A('PUT', `/rest/api/2/project/TEST/recurring-issue/${ruleId}`, { active: true });
      expect(new Date((await res.json()).nextRunAt).getTime()).toBeGreaterThan(Date.now());
    });

    test('rules of archived projects never run', async () => {
      await db.update(schema.recurringIssues).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.recurringIssues.id, ruleId));
      await db.update(schema.projects).set({ archivedAt: new Date() }).where(eq(schema.projects.id, seeded.project.id));
      const before = await issuesCount();
      const r = await runDueRecurring(new Date());
      expect(r.created).toBe(0);
      expect(r.skipped).toBe(1);
      expect(await issuesCount()).toBe(before);
      await db.update(schema.projects).set({ archivedAt: null }).where(eq(schema.projects.id, seeded.project.id));
    });

    test('a failing slot is logged, not retried', async () => {
      await db.update(schema.recurringIssues).set({ ownerId: (await db.select().from(schema.users).where(eq(schema.users.username, 'bob')))[0].id, nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.recurringIssues.id, ruleId));
      const r = await runDueRecurring(new Date());
      expect(r.failed).toBe(1);
      const failed = (await slotsOf()).filter((x) => x.status === 'failed');
      expect(failed[0].error).toMatch(/may not create issues/);
      expect((await runDueRecurring(new Date())).failed).toBe(0);
    });

    test('delete the rule', async () => {
      expect((await A('DELETE', `/rest/api/2/project/TEST/recurring-issue/${ruleId}`)).status).toBe(200);
      expect((await A('DELETE', `/rest/api/2/project/TEST/recurring-issue/${ruleId}`)).status).toBe(404);
      expect((await A('DELETE', `/rest/api/2/issue-template/${globalId}`)).status).toBe(200);
    });
  });

  describe('project templates and copy', () => {
    test('catalogue lists the four templates', async () => {
      const res = await (await A('GET', '/rest/api/2/project-template')).json();
      expect(res.templates.map((t: any) => t.id)).toEqual(['software', 'kanban', 'business', 'bug']);
      expect((await app.request('/rest/api/2/project-template')).status).toBe(401);
    });

    test('create from a template configures the board and issue templates', async () => {
      const res = await A('POST', '/rest/api/2/project', { key: 'KAN', name: 'Kanban project', template: 'kanban' });
      expect(res.status).toBe(201);
      const out = await res.json();
      expect(out.applied.board).toContain('kanban');
      expect(out.applied.issueTemplates).toBeGreaterThan(0);
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'KAN'));
      const boards = await db.select().from(schema.boards).where(eq(schema.boards.projectId, p.id));
      expect(boards.length).toBe(1);
      expect(boards[0].type).toBe('kanban');
      const tpls = await (await A('GET', '/rest/api/2/issue-template?projectKey=KAN')).json();
      expect(tpls.templates.some((t: any) => t.name === 'Task')).toBe(true);
      const bug = await A('POST', '/rest/api/2/project', { key: 'BUGS', name: 'Bugs', template: 'bug' });
      expect((await bug.json()).applied.components).toBe(3);
      expect((await A('POST', '/rest/api/2/project', { key: 'NOPE', name: 'x', template: 'unknown' })).status).toBe(400);
    });

    test('copy settings from a project with preview', async () => {
      const prev = await (await A('GET', '/rest/api/2/project/TEST/copy-preview')).json();
      expect(prev.components).toContain('Backend');
      expect(prev.issueTemplates).toContain('Bug report');
      const res = await A('POST', '/rest/api/2/project', { key: 'CPY', name: 'Copy', copyFrom: { projectKey: 'TEST', components: true, versions: false, issueTemplates: true, roleActors: false } });
      expect(res.status).toBe(201);
      const out = await res.json();
      expect(out.applied.components).toBe(1);
      expect(out.applied.issueTemplates).toBe(1);
      const comps = await (await A('GET', '/rest/api/2/project/CPY/components')).json();
      expect(JSON.stringify(comps)).toContain('Backend');
      expect((await A('POST', '/rest/api/2/project', { key: 'CP2', name: 'Copy', copyFrom: { projectKey: 'TEST', surprise: true } })).status).toBe(400);
      expect((await A('POST', '/rest/api/2/project', { key: 'CP3', name: 'Copy', copyFrom: { projectKey: 'NOSUCH' } })).status).toBe(404);
      expect((await call(bob, 'GET', '/rest/api/2/project/TEST/copy-preview')).status).toBe(403);
    });
  });

  describe('archive, restore, delete', () => {
    let issueKey: string;
    test('archived projects are read-only with a clear 409', async () => {
      issueKey = (await (await A('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Before archive' } })).json()).key;
      expect((await call(bob, 'POST', '/rest/api/2/project/TEST/archive')).status).toBe(403);
      const res = await A('POST', '/rest/api/2/project/TEST/archive');
      expect(res.status).toBe(200);
      expect((await A('POST', '/rest/api/2/project/TEST/archive')).status).toBe(409);

      const create = await A('POST', '/rest/api/2/issue', { fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'Nope' } });
      expect(create.status).toBe(409);
      expect((await create.json()).errorMessages[0]).toMatch(/archived and read-only/);
      expect((await A('POST', '/rest/api/2/issue', { fields: { project: { key: 'TEST' }, issuetype: { id: seeded.issueType.id }, summary: 'Nope' } })).status).toBe(409);
      expect((await A('PUT', `/rest/api/2/issue/${issueKey}`, { fields: { summary: 'Edited' } })).status).toBe(409);
      expect((await A('POST', `/rest/api/2/issue/${issueKey}/comment`, { body: 'hi' })).status).toBe(409);
      expect((await A('DELETE', `/rest/api/2/issue/${issueKey}`)).status).toBe(409);
      expect((await A('PUT', '/rest/api/2/project/TEST', { name: 'Renamed' })).status).toBe(409);
      expect((await A('POST', `/rest/api/2/issue-template/${templateId}/issue`, { projectKey: 'TEST' })).status).toBe(409);
      expect((await A('POST', '/rest/api/2/project/TEST/components', { name: 'More' })).status).toBe(409);
      // reads and direct links keep working
      expect((await A('GET', `/rest/api/2/issue/${issueKey}`)).status).toBe(200);
      expect((await A('GET', '/rest/api/2/project/TEST')).status).toBe(200);
    });

    test('hidden from lists and default search, reachable with the filter', async () => {
      const def = await (await A('GET', '/rest/api/2/project?nocache=1')).json();
      expect(def.map((p: any) => p.key)).not.toContain('TEST');
      const only = await (await A('GET', '/rest/api/2/project?archived=only&nocache=1')).json();
      expect(only.map((p: any) => p.key)).toEqual(['TEST']);
      expect(only[0].archived).toBe(true);
      expect((await A('GET', '/rest/api/2/project?archived=bogus&nocache=1')).status).toBe(400);
      const all = await (await A('GET', '/rest/api/2/project?archived=include&nocache=1')).json();
      expect(all.map((p: any) => p.key)).toContain('TEST');
      const s1 = await (await A('GET', '/rest/api/2/search?jql=' + encodeURIComponent('order by created DESC') + '&nocache=1')).json();
      expect(s1.issues.some((i: any) => i.key === issueKey)).toBe(false);
      const s2 = await (await A('GET', '/rest/api/2/search?jql=' + encodeURIComponent('project = TEST') + '&nocache=1')).json();
      expect(s2.issues.some((i: any) => i.key === issueKey)).toBe(true);
      const s3 = await (await A('GET', '/rest/api/2/search?includeArchived=true&nocache=1')).json();
      expect(s3.issues.some((i: any) => i.key === issueKey)).toBe(true);
    });

    test('restore makes the project writable again', async () => {
      expect((await call(bob, 'POST', '/rest/api/2/project/TEST/restore')).status).toBe(403);
      expect((await A('POST', '/rest/api/2/project/TEST/restore')).status).toBe(200);
      expect((await A('POST', '/rest/api/2/project/TEST/restore')).status).toBe(409);
      expect((await A('PUT', `/rest/api/2/issue/${issueKey}`, { fields: { summary: 'Edited after restore' } })).status).toBeLessThan(300);
      const def = await (await A('GET', '/rest/api/2/project?nocache=1')).json();
      expect(def.map((p: any) => p.key)).toContain('TEST');
    });

    test('deleting needs an archived project and an exact confirmation', async () => {
      expect((await A('POST', '/rest/api/2/project', { key: 'DEL', name: 'Delete me' })).status).toBe(201);
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'DEL'));
      const mk = await A('POST', '/rest/api/2/issue', { fields: { project: { id: p.id }, issuetype: { id: seeded.issueType.id }, summary: 'Doomed' } });
      expect(mk.status).toBe(201);
      const [doomed] = await db.select().from(schema.issues).where(eq(schema.issues.projectId, p.id));
      const dir = process.env.MOCK_STORAGE_DIR || '/tmp/veqsio-attachments';
      await Bun.write(`${dir}/DEL/doomed-file.txt`, 'x');
      await db.insert(schema.attachments).values({ issueId: doomed.id, filename: 'a.txt', filesize: 1, mimetype: 'text/plain', storageKey: 'DEL/doomed-file.txt', authorId: doomed.reporterId! });
      const confirm = { confirmKey: 'DEL', confirmPhrase: 'delete this project' };
      expect((await A('DELETE', '/rest/api/2/project/DEL')).status).toBe(400); // no confirmation
      expect((await A('DELETE', '/rest/api/2/project/DEL', { confirmKey: 'DEL', confirmPhrase: 'yes' })).status).toBe(400);
      expect((await A('DELETE', '/rest/api/2/project/DEL', { ...confirm, confirmKey: 'del' })).status).toBe(400);
      const live = await A('DELETE', '/rest/api/2/project/DEL', confirm);
      expect(live.status).toBe(409);
      expect((await live.json()).errorMessages[0]).toMatch(/Only archived projects/);
      expect((await call(bob, 'DELETE', '/rest/api/2/project/DEL', confirm)).status).toBe(403);
      expect((await A('POST', '/rest/api/2/project/DEL/archive')).status).toBe(200);
      expect((await A('DELETE', '/rest/api/2/project/DEL', confirm)).status).toBe(200);
      expect((await A('GET', '/rest/api/2/project/DEL')).status).toBe(404);
      expect(await Bun.file(`${dir}/DEL/doomed-file.txt`).exists()).toBe(false); // stored file removed too
      expect((await db.select().from(schema.issues).where(eq(schema.issues.projectId, p.id))).length).toBe(0);
      // the lifecycle is recorded in the audit log
      const audit = await testSql`SELECT action, target FROM audit_log WHERE target = 'DEL' ORDER BY id`;
      const actions = audit.map((r: any) => r.action);
      expect(actions).toContain('PROJECT_ARCHIVED');
    });
  });

  describe('terminology option', () => {
    test('defaults to issue, can be changed by admins, rejects other values', async () => {
      expect((await (await app.request('/rest/api/2/settings/public')).json()).issueTerm).toBe('issue');
      expect((await A('PUT', '/rest/api/2/admin/settings', { issueTerm: 'story' })).status).toBe(400);
      expect((await call(bob, 'PUT', '/rest/api/2/admin/settings', { issueTerm: 'ticket' })).status).toBe(403);
      expect((await A('PUT', '/rest/api/2/admin/settings', { issueTerm: 'work item' })).status).toBe(200);
      expect((await (await app.request('/rest/api/2/settings/public')).json()).issueTerm).toBe('work item');
      await A('PUT', '/rest/api/2/admin/settings', { issueTerm: 'issue' });
    });
  });
});
