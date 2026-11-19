import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { and, eq } from 'drizzle-orm';
import { redis } from '../../src/services/cache';
import app from '../../src/app';
import { createAdapter, runSourceImport, setToolTransportOverride } from '../../src/migration/tools';
import { LinearClient } from '../../src/migration/tools/linear';
import { AsanaClient } from '../../src/migration/tools/asana';
import { ClickupClient } from '../../src/migration/tools/clickup';
import { ToolAuthError, ToolRateLimitError } from '../../src/migration/tools/http';
import { GenericJsonSource, JsonFileError } from '../../src/migration/tools/generic';
import { createFakeProviders, TOKENS } from '../fixtures/fake-providers';
import genericText from '../fixtures/generic.json';

const GENERIC = JSON.stringify(genericText);

describe('Import from Linear, Asana, ClickUp and JSON', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  let admin: string, bob: string;
  let fake = createFakeProviders();

  const use = (f = createFakeProviders()) => { fake = f; setToolTransportOverride({ fetchImpl: f.fetch, sleep: f.sleep }); return f; };
  const call = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.request(url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const T = '/rest/api/2/migration/tools';

  async function waitDone(id: number): Promise<any> {
    for (let i = 0; i < 400; i++) {
      const s = (await (await call(admin, 'GET', `${T}/sessions/${id}`)).json()).session;
      if (s.report || s.status === 'failed') return s;
      await Bun.sleep(25);
    }
    throw new Error('import did not finish');
  }
  async function run(source: string, body: Record<string, unknown>) {
    const res = await call(admin, 'POST', `${T}/${source}/run`, body);
    expect(res.status).toBe(202);
    return waitDone((await res.json()).sessionId);
  }
  const issueBySummary = async (summary: string) => (await db.select().from(schema.issues).where(eq(schema.issues.summary, summary)))[0];
  const nameOf = async (table: any, id: number | null) => (id === null ? null : (await db.select().from(table).where(eq((table as any).id, id)))[0].name);

  beforeAll(async () => {
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bobby', email: 'bobby@example.com', displayName: 'Bobby', passwordHash: hash });
    for (let uid = 1; uid <= 8; uid++) await redis.del(`veqsio:ratelimit:user:${uid}`);
    const login = async (username: string) => (await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    })).headers.get('set-cookie') || '';
    admin = await login('admin');
    bob = await login('bobby');
    use();
  });
  afterAll(async () => {
    setToolTransportOverride({});
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ------------------------------------------------------------------ */
  describe('access control and hygiene', () => {
    test('admin only, authenticated, known sources', async () => {
      for (const [m, p, b] of [['GET', `${T}/sources`], ['POST', `${T}/linear/test`, { token: 'x'.repeat(10) }], ['POST', `${T}/linear/analyze`, { token: 'x'.repeat(10) }],
        ['POST', `${T}/linear/run`, { token: 'x'.repeat(10) }], ['GET', `${T}/sessions`], ['GET', `${T}/sessions/1`], ['POST', `${T}/sessions/1/cancel`]] as const) {
        expect((await app.request(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status, `anon ${m} ${p}`).toBe(401);
        expect((await call(bob, m, p, b)).status, `non-admin ${m} ${p}`).toBe(403);
      }
      expect((await call(admin, 'POST', `${T}/trello/test`, { token: 'x'.repeat(10) })).status).toBe(404);
      expect((await call(admin, 'GET', `${T}/sessions/abc`)).status).toBe(404);
      expect((await call(admin, 'GET', `${T}/sessions/999999`)).status).toBe(404);
    });

    test('lists the six sources metadata', async () => {
      const { sources } = await (await call(admin, 'GET', `${T}/sources`)).json();
      expect(sources.map((s: any) => s.id)).toEqual(['linear', 'asana', 'clickup', 'json']);
      expect(sources.every((s: any) => s.maps.length > 0 && s.unsupported.length > 0)).toBe(true);
    });

    test('validates bodies: missing token, unknown keys, bad options', async () => {
      expect((await call(admin, 'POST', `${T}/linear/run`, { dryRun: true })).status).toBe(400);
      expect((await call(admin, 'POST', `${T}/linear/run`, { token: 'x'.repeat(10), evil: 1 })).status).toBe(400);
      expect((await call(admin, 'POST', `${T}/linear/run`, { token: 'x'.repeat(10), options: { projectKeys: { a: 'bad key!' } } })).status).toBe(400);
      expect((await call(admin, 'POST', `${T}/json/analyze`, { json: '{not json' })).status).toBe(400);
    });

    test('a rejected token is reported without echoing it', async () => {
      use();
      const res = await call(admin, 'POST', `${T}/linear/test`, { token: 'definitely-wrong-token' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('AUTH_FAILED');
      expect(JSON.stringify(body)).not.toContain('definitely-wrong-token');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('HTTP client behaviour (recorded fixtures, no network)', () => {
    test('429 + Retry-After is honoured, then the call succeeds', async () => {
      const f = createFakeProviders({ throttle: { count: 2, retryAfter: '2' } });
      const c = new LinearClient({ token: TOKENS.linear, fetchImpl: f.fetch, sleep: f.sleep });
      expect((await c.viewer()).name).toBe('Alice Admin');
      expect(f.sleeps).toEqual([2000, 2000]);
    });

    test('gives up with a rate limit error after the retries are used', async () => {
      const f = createFakeProviders({ throttle: { count: 50, retryAfter: '1' } });
      const c = new AsanaClient({ token: TOKENS.asana, fetchImpl: f.fetch, sleep: f.sleep, retries: 2 });
      await expect(c.viewer()).rejects.toBeInstanceOf(ToolRateLimitError);
      expect(f.sleeps).toEqual([1000, 1000]);
    });

    test('Linear RATELIMITED GraphQL errors back off until the reset time', async () => {
      const f = createFakeProviders({ linearRateLimited: true });
      const c = new LinearClient({ token: TOKENS.linear, fetchImpl: f.fetch, sleep: f.sleep });
      await c.viewer();
      expect(f.sleeps).toHaveLength(1);
      expect(f.sleeps[0]).toBeGreaterThan(1000);
      expect(f.sleeps[0]).toBeLessThanOrEqual(3000);
    });

    test('authentication failures are typed for every provider', async () => {
      const f = createFakeProviders();
      await expect(new LinearClient({ token: 'bad', fetchImpl: f.fetch, sleep: f.sleep }).viewer()).rejects.toBeInstanceOf(ToolAuthError);
      await expect(new AsanaClient({ token: 'bad', fetchImpl: f.fetch, sleep: f.sleep }).viewer()).rejects.toBeInstanceOf(ToolAuthError);
      await expect(new ClickupClient({ token: 'bad', fetchImpl: f.fetch, sleep: f.sleep }).viewer()).rejects.toBeInstanceOf(ToolAuthError);
      expect(f.sleeps).toEqual([]); // auth errors are not retried
    });

    test('never follows a pagination link to another host', async () => {
      const f = createFakeProviders({ evilNextPage: true });
      const c = new AsanaClient({ token: TOKENS.asana, fetchImpl: f.fetch, sleep: f.sleep });
      const ctx = { unsupported: new (await import('../../src/migration/tools/model')).UnsupportedCollector(), isCancelled: () => false };
      await expect((async () => { for await (const _ of c.extract({ containerIds: ['p1'] }, ctx)) { /* drain */ } })()).rejects.toThrow(/outside Asana/);
      expect(f.calls.some((x) => x.url.includes('evil.example'))).toBe(false);
    });

    test('pagination: Asana projects across two pages, ClickUp lists, Linear teams', async () => {
      const f = createFakeProviders();
      const asana = await new AsanaClient({ token: TOKENS.asana, fetchImpl: f.fetch, sleep: f.sleep }).containers({});
      expect(asana.map((c) => [c.id, c.group, c.issueCount])).toEqual([['p1', 'Corp', 4], ['p2', 'Corp', 0]]);
      const cu = new ClickupClient({ token: TOKENS.clickup, fetchImpl: f.fetch, sleep: f.sleep });
      expect((await cu.containers({})).map((c) => [c.id, c.issueCount])).toEqual([['space:s1', 3]]);
      expect((await cu.containers({ groupBy: 'list' })).map((c) => c.id)).toEqual(['list:l1', 'list:l2']);
      const lin = await new LinearClient({ token: TOKENS.linear, fetchImpl: f.fetch, sleep: f.sleep }).containers();
      expect(lin.map((c) => [c.id, c.suggestedKey])).toEqual([['team-eng', 'ENG'], ['team-dsg', 'DSG']]);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('Linear', () => {
    let aliceId: number;
    beforeAll(async () => {
      const [a] = await db.insert(schema.users).values({ username: 'alice', email: 'Alice@Corp.Example', displayName: 'Alice Existing' }).returning();
      aliceId = a.id;
    });

    test('analyze lists teams with a free project key', async () => {
      use();
      const res = await call(admin, 'POST', `${T}/linear/analyze`, { token: TOKENS.linear });
      const { containers } = await res.json();
      expect(containers.map((c: any) => [c.id, c.suggestedKey, c.existsInVeqsio])).toEqual([['team-eng', 'ENG', false], ['team-dsg', 'DSG', false]]);
    });

    test('dry run: counts, user matching, new values and unsupported data, nothing written', async () => {
      use();
      const s = await run('linear', { token: TOKENS.linear, dryRun: true });
      expect(s.status).toBe('completed');
      const r = s.report;
      expect(r.dryRun).toBe(true);
      expect(r.totals).toMatchObject({ projects: 2, issues: 3, created: 3, updated: 0, comments: 3, links: 2, subtasks: 1, sprints: 2 });
      expect(r.users).toMatchObject({ matched: 1, created: 2, unmatched: 0 }); // alice matched by e-mail (case-insensitive); bob and zed would be created
      expect(r.users.sample.map((u: any) => u.email).sort()).toEqual(['bob@corp.example', 'zed@corp.example']);
      expect(r.newValues.statuses).toEqual(expect.arrayContaining(['Backlog', 'Todo', 'Done', 'Canceled']));
      expect(r.newValues.issueTypes).toEqual(expect.arrayContaining(['Bug', 'Sub-task']));
      expect(r.newValues.priorities).toEqual(['Highest']);
      expect(r.newValues.labels).toEqual(expect.arrayContaining(['Bug', 'customer-facing', 'tech-debt']));
      expect(r.unsupported['attachments / linked URLs']).toBe(1);
      expect(r.warnings.some((w: string) => w.includes('Not imported: attachments / linked URLs (1 item)'))).toBe(true);
      expect(r.warnings.some((w: string) => w.includes('never imported from linear'))).toBe(true);
      expect(await db.select().from(schema.issues)).toHaveLength(0);
      expect(await db.select().from(schema.migrationExternalRefs)).toHaveLength(0);
      expect(await db.select().from(schema.projects)).toHaveLength(1);
    });

    let sessionId: number;
    test('real import creates projects, issues, statuses, sprints, comments, parents, links and placeholder users', async () => {
      use();
      const res = await call(admin, 'POST', `${T}/linear/run`, { token: TOKENS.linear, dryRun: false });
      expect(res.status).toBe(202);
      sessionId = (await res.json()).sessionId;
      const s = await waitDone(sessionId);
      expect(s.status).toBe('completed');
      expect(s.report.errors).toEqual([]);
      expect(s.report.totals).toMatchObject({ projects: 2, issues: 3, created: 3, failed: 0, comments: 3, links: 2, sprints: 2 });

      const [eng] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'ENG'));
      expect(eng.name).toBe('Engineering');
      expect((await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'DSG')))).toHaveLength(1);

      const i1 = await issueBySummary('Login fails for SSO users');
      const i2 = await issueBySummary('Add regression test');
      const i3 = await issueBySummary('Drop legacy endpoint');
      expect([i1.issueKey, i2.issueKey, i3.issueKey]).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
      expect(await nameOf(schema.priorities, i1.priorityId)).toBe('Highest');
      expect(await nameOf(schema.priorities, i2.priorityId)).toBe('Medium');
      expect(i3.priorityId).toBeNull();
      expect(Number(i1.storyPoints)).toBe(5);
      expect(await nameOf(schema.statuses, i1.statusId)).toBe('Done');
      expect(await nameOf(schema.resolutions, i1.resolutionId)).toBe('Done');
      expect(await nameOf(schema.resolutions, i3.resolutionId)).toBe("Won't Do");
      expect(await nameOf(schema.statuses, i2.statusId)).toBe('In Progress'); // matched the existing status by name
      expect(await nameOf(schema.issueTypes, i1.issueTypeId)).toBe('Bug');
      expect(await nameOf(schema.issueTypes, i2.issueTypeId)).toBe('Sub-task');
      expect(i2.parentId).toBe(i1.id);
      expect(i1.createdAt?.toISOString()).toBe('2020-01-07T10:00:00.000Z');
      expect(i1.dueDate?.toISOString().slice(0, 10)).toBe('2020-01-15');
      expect(i1.assigneeId).toBe(aliceId); // matched by e-mail, not duplicated
      expect(i3.assigneeId).toBeNull();
      expect(i3.reporterId).toBe(seeded.user.id); // no creator in Linear -> importing admin

      const [bobUser] = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@corp.example'));
      expect(bobUser).toMatchObject({ displayName: 'Bob B', passwordHash: null, active: true });
      expect(i1.reporterId).toBe(bobUser.id);
      expect((await db.select().from(schema.users)).filter((u) => u.email.toLowerCase() === 'alice@corp.example')).toHaveLength(1);

      const comments = await db.select().from(schema.comments).where(eq(schema.comments.issueId, i1.id));
      expect(comments.map((c) => c.body).sort()).toEqual(['Fixed in 1.2', 'Looking into it', 'Released']); // third one came from comment pagination

      const labels = await db.select({ n: schema.labels.name }).from(schema.issueLabels).innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, i1.id));
      expect(labels.map((l) => l.n).sort()).toEqual(['Bug', 'customer-facing']);
      const comps = await db.select({ n: schema.components.name }).from(schema.issueComponents).innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(eq(schema.issueComponents.issueId, i1.id));
      expect(comps.map((c) => c.n)).toEqual(['Platform']);

      const links = await db.select().from(schema.issueLinks);
      expect(links).toHaveLength(2);
      const blocks = links.find((l) => l.issueId === i1.id && l.linkedIssueId === i3.id)!;
      expect((await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, blocks.linkTypeId!)))[0].name).toBe('Blocks');

      const [board] = await db.select().from(schema.boards).where(eq(schema.boards.projectId, eng.id));
      expect(board).toMatchObject({ name: 'Engineering board', type: 'scrum' });
      const cols = await db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, board.id));
      expect(cols.map((c) => c.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled']);
      const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.boardId, board.id));
      expect(sprints.map((x) => [x.name, x.state]).sort()).toEqual([['Cycle 1', 'closed'], ['Cycle 2', 'active']]);
      const members = await db.select().from(schema.sprintIssues);
      expect(members).toHaveLength(2);

      // the stored session never contains the token
      const [row] = await db.select().from(schema.migrationSessions).where(eq(schema.migrationSessions.id, sessionId));
      expect(JSON.stringify(row)).not.toContain(TOKENS.linear);
      expect(row.backupPath).toBe('linear:import');
    });

    test('re-running updates instead of duplicating (issues, comments, links, sprints, users)', async () => {
      const i1 = await issueBySummary('Login fails for SSO users');
      await db.update(schema.issues).set({ summary: 'Login fails for SSO users', storyPoints: '1.00' }).where(eq(schema.issues.id, i1.id));
      await db.insert(schema.users).values({ username: 'x', email: 'x@x.x', displayName: 'X' }); // unrelated
      const before = (await db.select().from(schema.users)).length;
      use();
      const s = await run('linear', { token: TOKENS.linear, dryRun: false });
      expect(s.report.totals).toMatchObject({ issues: 3, created: 0, updated: 3, failed: 0 });
      expect(await db.select().from(schema.issues)).toHaveLength(3);
      expect(await db.select().from(schema.comments)).toHaveLength(3);
      expect(await db.select().from(schema.issueLinks)).toHaveLength(2);
      expect(await db.select().from(schema.sprints)).toHaveLength(2);
      expect(await db.select().from(schema.sprintIssues)).toHaveLength(2);
      expect(await db.select().from(schema.projects)).toHaveLength(3); // TEST, ENG, DSG
      expect((await db.select().from(schema.users)).length).toBe(before);
      expect(Number((await issueBySummary('Login fails for SSO users')).storyPoints)).toBe(5); // restored from the source
      const refs = await db.select().from(schema.migrationExternalRefs).where(eq(schema.migrationExternalRefs.source, 'linear'));
      expect(refs.filter((r) => r.entityType === 'issue')).toHaveLength(3);

      const skip = await run('linear', { token: TOKENS.linear, dryRun: false, options: { onExisting: 'skip' } });
      expect(skip.report.totals).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    });

    test('analyze reports that the teams already exist', async () => {
      use();
      const { containers } = await (await call(admin, 'POST', `${T}/linear/analyze`, { token: TOKENS.linear })).json();
      expect(containers.map((c: any) => c.existsInVeqsio)).toEqual([true, true]);
    });

    test('admin chosen key and selection: only the chosen team is imported, into a fresh project key', async () => {
      use();
      const s = await run('linear', { token: TOKENS.linear, dryRun: true, options: { containerIds: ['team-dsg'], projectKeys: {} } });
      expect(s.report.totals.projects).toBe(1);
      expect(s.report.projects[0]).toMatchObject({ key: 'DSG', existed: true });
    });
  });

  /* ------------------------------------------------------------------ */
  describe('Asana', () => {
    test('dry run', async () => {
      use();
      const s = await run('asana', { token: TOKENS.asana, dryRun: true });
      const r = s.report;
      expect(r.totals).toMatchObject({ projects: 2, issues: 4, created: 4, comments: 2, subtasks: 1 });
      expect(r.users.matched).toBe(2); // alice and bob exist from the Linear import
      expect(r.users.created).toBe(1); // Carol exposes no e-mail -> placeholder identity
      expect(r.users.sample).toEqual([{ name: 'Carol C', email: null, action: 'create' }]);
      expect(r.unsupported['custom field "Budget"']).toBe(1);
      expect(r.unsupported['milestone type (imported as issue type Milestone)']).toBe(1);
      expect(Object.keys(r.unsupported).some((k) => k.includes('Empty field'))).toBe(false);
      expect(await db.select().from(schema.issues).where(eq(schema.issues.summary, 'Design homepage'))).toHaveLength(0);
    });

    let t1Id: number;
    test('import without creating missing users leaves them unassigned', async () => {
      use();
      const s = await run('asana', { token: TOKENS.asana, dryRun: false, options: { createMissingUsers: false } });
      expect(s.status).toBe('completed');
      expect(s.report.errors).toEqual([]);
      expect(s.report.users).toMatchObject({ unmatched: 1, created: 0 });
      expect(s.report.users.sample[0].action).toBe('unassigned');

      const [wr] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'WR'));
      expect(wr.name).toBe('Website Redesign');
      expect(wr.description).toBe('Redesign the marketing site');
      expect((await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'MARK')))).toHaveLength(1);

      const t1 = await issueBySummary('Design homepage');
      t1Id = t1.id;
      const t2 = await issueBySummary('Write copy');
      const t3 = await issueBySummary('Launch');
      const sub = await issueBySummary('Pick colours');
      expect(await nameOf(schema.statuses, t1.statusId)).toBe('In Progress'); // section "In progress" matched case-insensitively
      expect(await nameOf(schema.priorities, t1.priorityId)).toBe('High');
      expect(Number(t1.storyPoints)).toBe(8);
      expect([t1.timeEstimate, t1.timeSpent]).toEqual([7200, 1800]);
      expect(t1.dueDate?.toISOString().slice(0, 10)).toBe('2021-03-20');
      expect(t1.startDate?.toISOString().slice(0, 10)).toBe('2021-03-02');
      expect((await db.select({ n: schema.users.username }).from(schema.users).where(eq(schema.users.id, t1.assigneeId!)))[0].n).toBe('bob');
      const lbl = await db.select({ n: schema.labels.name }).from(schema.issueLabels).innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, t1.id));
      expect(lbl.map((l) => l.n).sort()).toEqual(['design', 'q1-goal']);

      expect(await nameOf(schema.statuses, t2.statusId)).toBe('Done'); // completed tasks go to Done
      expect(await nameOf(schema.resolutions, t2.resolutionId)).toBe('Done');
      expect(t2.reporterId).toBe(seeded.user.id); // Carol is unmatched and not created -> importing admin
      expect(t2.assigneeId).toBeNull();
      expect(await nameOf(schema.issueTypes, t3.issueTypeId)).toBe('Milestone');
      expect(sub.parentId).toBe(t1.id);
      expect(await nameOf(schema.issueTypes, sub.issueTypeId)).toBe('Sub-task');

      const comments = await db.select().from(schema.comments).where(eq(schema.comments.issueId, t1.id));
      expect(comments.map((c) => c.body)).toEqual(['Mockups are in Figma']); // system stories are not comments

      const [board] = await db.select().from(schema.boards).where(eq(schema.boards.projectId, wr.id));
      expect(board).toMatchObject({ name: 'Website Redesign board', type: 'kanban' });
      const cols = await db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, board.id));
      expect(cols.map((c) => c.name)).toEqual(['To Do', 'In progress', 'Complete', 'Done']);
    });

    test('re-run updates in place; placeholder users appear only when allowed', async () => {
      use();
      const s = await run('asana', { token: TOKENS.asana, dryRun: false });
      expect(s.report.totals).toMatchObject({ created: 0, updated: 4 });
      expect(await db.select().from(schema.issues).where(eq(schema.issues.summary, 'Design homepage'))).toHaveLength(1);
      expect((await issueBySummary('Design homepage')).id).toBe(t1Id);
      const [carol] = await db.select().from(schema.users).where(eq(schema.users.email, 'asana-u3@migrated.invalid'));
      expect(carol).toMatchObject({ displayName: 'Carol C', passwordHash: null });
      const t2 = await issueBySummary('Write copy');
      expect(t2.reporterId).toBe(carol.id); // updated now that the person exists
      expect(await db.select().from(schema.comments)).toHaveLength(3 + 2);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('ClickUp', () => {
    test('import (one project per space) with paginated tasks and comments', async () => {
      const f = use();
      const s = await run('clickup', { token: TOKENS.clickup, dryRun: false });
      expect(s.status).toBe('completed');
      expect(s.report.errors).toEqual([]);
      expect(s.report.totals).toMatchObject({ projects: 1, issues: 3, created: 3, comments: 27, links: 2, subtasks: 1 });
      expect(f.calls.some((c) => c.url.includes('/list/l1/task?') && c.url.includes('page=1'))).toBe(true);
      expect(f.calls.some((c) => c.url.includes('start_id=cm25'))).toBe(true);

      const [pd] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'PD'));
      expect(pd.name).toBe('Product Development');
      const c1 = await issueBySummary('Implement billing');
      const c2 = await issueBySummary('Invoice template');
      const c3 = await issueBySummary('Go live');
      expect(c1.description).toBe('**Billing** details');
      expect(await nameOf(schema.statuses, c1.statusId)).toBe('In Review');
      expect(await nameOf(schema.statuses, c2.statusId)).toBe('Complete');
      expect(await nameOf(schema.resolutions, c2.resolutionId)).toBe('Done');
      expect(await nameOf(schema.priorities, c1.priorityId)).toBe('High');
      expect(await nameOf(schema.priorities, c3.priorityId)).toBe('Low');
      expect([c1.timeEstimate, c1.timeSpent, Number(c1.storyPoints)]).toEqual([7200, 1800, 3]);
      expect(c1.dueDate?.toISOString()).toBe('2021-02-01T00:00:00.000Z');
      // first assignee; Carol already exists from the Asana import and is matched by display name like the Jira importer does
      expect((await db.select({ n: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, c1.assigneeId!)))[0].n).toBe('Carol C');
      expect(c2.parentId).toBe(c1.id);
      expect(await db.select().from(schema.comments).where(eq(schema.comments.issueId, c1.id))).toHaveLength(26);
      const comps = await db.select({ n: schema.components.name }).from(schema.issueComponents).innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(eq(schema.issueComponents.issueId, c1.id));
      expect(comps.map((c) => c.n)).toEqual(['Sprint Board / Backlog']);

      const links = (await db.select().from(schema.issueLinks)).filter((l) => [c1.id, c2.id, c3.id].includes(l.issueId));
      expect(links).toHaveLength(2); // blocking dependency and the linked task, each once although both tasks report them
      expect(links.some((l) => l.issueId === c1.id && l.linkedIssueId === c3.id)).toBe(true);

      const u = s.report.unsupported;
      expect(u['additional assignees (only the first is imported)']).toBe(1);
      expect(u.checklists).toBe(1);
      expect(u.attachments).toBe(1);
      expect(u['custom fields']).toBe(1);
      const cols = await db.select().from(schema.boardColumns).innerJoin(schema.boards, eq(schema.boards.id, schema.boardColumns.boardId)).where(eq(schema.boards.projectId, pd.id));
      expect(cols.map((c) => c.board_columns.name)).toEqual(['To Do', 'In Review', 'Complete']);
    });

    test('one project per list and idempotent re-run', async () => {
      use();
      const s = await run('clickup', { token: TOKENS.clickup, dryRun: true, options: { groupBy: 'list' } });
      expect(s.report.totals).toMatchObject({ projects: 2, issues: 3, updated: 3, links: 2 });
      const again = await run('clickup', { token: TOKENS.clickup, dryRun: false });
      expect(again.report.totals).toMatchObject({ created: 0, updated: 3 });
      expect(await db.select().from(schema.comments).where(eq(schema.comments.issueId, (await issueBySummary('Implement billing')).id))).toHaveLength(26);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('Generic JSON', () => {
    test('rejects files that are not JSON or do not match the schema', async () => {
      expect(() => new GenericJsonSource('{nope')).toThrow(JsonFileError);
      expect(() => new GenericJsonSource('{"projects": []}')).toThrow(/does not match/);
      expect(() => new GenericJsonSource('{"projects":[{"id":"a","name":"A","issues":[]},{"id":"a","name":"B","issues":[]}]}')).toThrow(/Duplicate project id/);
    });

    test('dry run reports skipped rows, unknown properties and bad dates as warnings', async () => {
      use();
      const s = await run('json', { json: GENERIC, dryRun: true });
      const r = s.report;
      expect(r.totals).toMatchObject({ projects: 1, issues: 3, created: 3, comments: 2, links: 1, sprints: 2 });
      expect(r.unsupported['unknown property "customerId"']).toBe(1);
      expect(r.unsupported['unparseable dueDate dates']).toBe(1);
      expect(r.warnings.some((w: string) => w.includes('issue #4 skipped: title is missing'))).toBe(true);
      expect(r.warnings.some((w: string) => w.includes('"3" skipped: duplicate id'))).toBe(true);
      expect(r.warnings.some((w: string) => w.includes('1 sub-issue(s) point to a parent that was not part of this import'))).toBe(true);
      expect(r.users.sample.map((u: any) => u.name).sort()).toEqual(expect.arrayContaining(['Someone Without Email']));
    });

    test('import via multipart upload, then re-upload updates', async () => {
      use();
      const form = new FormData();
      form.set('file', new File([GENERIC], 'issues.json', { type: 'application/json' }));
      form.set('dryRun', 'false');
      form.set('options', JSON.stringify({ projectKeys: { 'default:web': 'WEB' } }));
      const res = await app.request(`${T}/json/run`, { method: 'POST', headers: { Cookie: admin }, body: form });
      expect(res.status).toBe(202);
      const s = await waitDone((await res.json()).sessionId);
      expect(s.status).toBe('completed');
      expect(s.report.totals).toMatchObject({ created: 3, comments: 2, links: 1, sprints: 2 });

      const [web] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'WEB'));
      expect(web.name).toBe('Website');
      const i1 = await issueBySummary('Set up hosting');
      const i2 = await issueBySummary('Write launch post');
      expect(i2.parentId).toBe(i1.id);
      expect(i1).toMatchObject({ timeEstimate: 28800, timeSpent: 7200 });
      expect(Number(i1.storyPoints)).toBe(3);
      expect(await nameOf(schema.statuses, i1.statusId)).toBe('Shipped');
      expect(await nameOf(schema.resolutions, i1.resolutionId)).toBe('Done');
      expect(i2.dueDate).toBeNull();
      expect((await db.select().from(schema.users).where(eq(schema.users.id, web.leadId!)))[0].email).toBe('lead@corp.example');
      const [board] = await db.select().from(schema.boards).where(eq(schema.boards.projectId, web.id));
      const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.boardId, board.id));
      expect(sprints.map((x) => [x.name, x.state]).sort()).toEqual([['Sprint 1', 'closed'], ['Sprint 2', 'active']]);
      expect((await db.select().from(schema.comments).where(eq(schema.comments.issueId, i1.id))).map((c) => c.body).sort()).toEqual(['Agreed', 'Use the EU region']);

      const again = await run('json', { json: GENERIC, dryRun: false });
      expect(again.report.totals).toMatchObject({ created: 0, updated: 3 });
      expect(await db.select().from(schema.issues).where(eq(schema.issues.summary, 'Set up hosting'))).toHaveLength(1);
      expect(await db.select().from(schema.comments).where(eq(schema.comments.issueId, i1.id))).toHaveLength(2);
    });

    test('createAdapter builds the right adapter and the explicit key merges into an existing project', async () => {
      expect(createAdapter('json', { json: GENERIC })).toBeInstanceOf(GenericJsonSource);
      const r = await runSourceImport({
        source: 'json', adapter: createAdapter('json', { json: GENERIC, namespace: 'other' }), extract: {}, userId: seeded.user.id,
        engine: { dryRun: true, projectKeys: { 'other:web': 'WEB' } },
      });
      expect(r.projects[0]).toMatchObject({ key: 'WEB', existed: true });
      expect(r.warnings.some((w) => w.includes('WEB: a project with this key already exists'))).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('progress, cancel and concurrency', () => {
    test('a running import can be cancelled; a second real import is refused meanwhile', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      use(createFakeProviders({ gate: () => gate }));
      const start = await call(admin, 'POST', `${T}/linear/run`, { token: TOKENS.linear, dryRun: false });
      expect(start.status).toBe(202);
      const id = (await start.json()).sessionId;

      const second = await call(admin, 'POST', `${T}/linear/run`, { token: TOKENS.linear, dryRun: false });
      expect(second.status).toBe(409);
      // a preview is still allowed
      expect((await call(admin, 'POST', `${T}/linear/run`, { token: TOKENS.linear, dryRun: true })).status).toBe(202);

      const cancel = await call(admin, 'POST', `${T}/sessions/${id}/cancel`);
      expect(cancel.status).toBe(200);
      release();
      const done = await waitDone(id);
      expect(done.status).toBe('cancelled');
      expect(done.report.cancelled).toBe(true);
      expect((await call(admin, 'POST', `${T}/sessions/${id}/cancel`)).status).toBe(409);
    });

    test('cancelling between items stops the engine and keeps what was imported', async () => {
      let n = 0;
      const r = await runSourceImport({
        source: 'asana', adapter: createAdapter('asana', { token: TOKENS.asana }), extract: { containerIds: ['p1'] }, userId: seeded.user.id,
        engine: { dryRun: true },
      }, { isCancelled: () => ++n > 3 });
      expect(r.cancelled).toBe(true);
      expect(r.totals.issues).toBeLessThan(4);
      expect(r.warnings.some((w) => w.includes('Import cancelled'))).toBe(true);
    });

    test('progress is written to the session while importing and failures end in status failed', async () => {
      use();
      const bad = await call(admin, 'POST', `${T}/asana/run`, { token: 'wrong-wrong', dryRun: true });
      const s = await waitDone((await bad.json()).sessionId);
      expect(s.status).toBe('failed');
      expect(s.errors[0]).toContain('rejected the credentials');
      expect(JSON.stringify(s)).not.toContain('wrong-wrong');

      const { sessions } = await (await call(admin, 'GET', `${T}/sessions`)).json();
      expect(sessions.length).toBeGreaterThan(5);
      expect(sessions[0].report).toBeNull(); // list view has no heavy reports
      const done = sessions.find((x: any) => x.status === 'completed' && !x.dryRun);
      expect(done.processed).toBeGreaterThan(0);
    });
  });
});
