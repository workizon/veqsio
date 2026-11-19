import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { invalidateIssueKeyCache } from '../../src/issues/service';
import { invalidateIssueCache } from '../../src/middleware/cache';

describe('Issue transitions API (issue view)', () => {
  let seeded: any;
  let cookie: string;
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let doneStatusId: number;
  let resolutionId: number;
  let resolveTransitionId: number;
  let startTransitionId: number;

  // The suite shares one user; clear the per-minute rate limit counters so these tests do not tip it over.
  async function clearRateLimits() {
    const keys = await redis.keys('veqsio:ratelimit:*');
    if (keys.length) await redis.del(...keys);
  }

  const headers = () => ({ 'Content-Type': 'application/json', Cookie: cookie });

  async function createIssue(summary: string, extra: Record<string, any> = {}) {
    const res = await app.request('/rest/api/2/issue', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary, ...extra },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; key: string };
  }

  async function transitions(key: string) {
    const res = await app.request(`/rest/api/2/issue/${key}/transitions`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return (await res.json()).transitions as any[];
  }

  async function post(key: string, body: any) {
    return app.request(`/rest/api/2/issue/${key}/transitions`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  }

  beforeAll(async () => {
    await clearRateLimits();
    testSql = createTestSql();
    await testSql`SELECT 1`;
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('admin123', 12);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));

    const loginRes = await app.request('/rest/auth/1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    cookie = loginRes.headers.get('set-cookie') || '';

    const [done] = await db.insert(schema.statuses).values({ name: 'Done', category: 'done', color: '#16A06A' }).returning();
    doneStatusId = done.id;
    const [res] = await db.insert(schema.resolutions).values({ name: 'Fixed' }).returning();
    resolutionId = res.id;

    const [start] = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, seeded.workflow.id));
    startTransitionId = start.id;
    const [resolve] = await db
      .insert(schema.workflowTransitions)
      .values({
        workflowId: seeded.workflow.id,
        name: 'Resolve',
        fromStatusId: seeded.status2.id,
        toStatusId: doneStatusId,
        conditions: [{ type: 'always_true' }],
        validators: [{ type: 'field_required', field: 'comment' }],
        postFunctions: [],
      })
      .returning();
    resolveTransitionId = resolve.id;
  });

  afterAll(async () => {
    await resetTestDb(testSql);
    await testSql.end();
  });

  test('GET transitions exposes target status category and input requirements', async () => {
    const issue = await createIssue('Transition meta');
    const list = await transitions(issue.key);
    const start = list.find((t) => t.id === startTransitionId);
    expect(start).toBeDefined();
    expect(start.name).toBe('Start Progress');
    expect(start.to.name).toBe('In Progress');
    expect(start.to.statusCategory.key).toBe('in_progress');
    expect(start.to.statusCategory.normalizedKey).toBe('in_progress');
    expect(start.requiresResolution).toBe(false);
    expect(start.requiresComment).toBe(false);
    expect(start.requiresInput).toBe(false);
    expect(start.hasScreen).toBe(false);
  });

  test('done-category transition asks for resolution and comment', async () => {
    const issue = await createIssue('Needs input');
    expect((await post(issue.key, { transition: { id: startTransitionId } })).status).toBe(200);
    const list = await transitions(issue.key);
    const resolve = list.find((t) => t.id === resolveTransitionId);
    expect(resolve).toBeDefined();
    expect(resolve.to.statusCategory.normalizedKey).toBe('done');
    expect(resolve.to.statusCategory.name).toBe('Done');
    expect(resolve.requiresResolution).toBe(true);
    expect(resolve.requiresComment).toBe(true);
    expect(resolve.requiresInput).toBe(true);
    expect(resolve.requiredFields).toContain('comment');
    expect(resolve.fields.comment.required).toBe(true);
  });

  test('validator failure returns the individual messages', async () => {
    const issue = await createIssue('Validator fail');
    await post(issue.key, { transition: { id: startTransitionId } });
    const res = await post(issue.key, { transition: { id: resolveTransitionId }, fields: { resolution: { id: resolutionId } } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorMessages[0]).toContain("Field 'comment' is required");
    expect(body.validationErrors).toEqual(["Field 'comment' is required"]);
    // Issue stays where it was
    const get = await app.request(`/rest/api/2/issue/${issue.key}`, { headers: { Cookie: cookie } });
    expect((await get.json()).fields.status.name).toBe('In Progress');
  });

  test('transition with resolution and Jira-style comment resolves the issue', async () => {
    const issue = await createIssue('Resolve me');
    await post(issue.key, { transition: { id: startTransitionId } });
    const res = await post(issue.key, {
      transition: { id: resolveTransitionId },
      fields: { resolution: { id: resolutionId } },
      update: { comment: [{ add: { body: 'Shipped in 1.0' } }] },
    });
    expect(res.status).toBe(200);

    const get = await app.request(`/rest/api/2/issue/${issue.key}`, { headers: { Cookie: cookie } });
    const body = await get.json();
    expect(body.fields.status.name).toBe('Done');
    expect(body.fields.resolution.name).toBe('Fixed');
    expect(body.fields.resolved).not.toBeNull();

    const comments = await app.request(`/rest/api/2/issue/${issue.key}/comment`, { headers: { Cookie: cookie } });
    const cbody = await comments.json();
    expect(cbody.comments.some((c: any) => c.body === 'Shipped in 1.0')).toBe(true);

    const hist = await db.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issue.id));
    expect(hist.some((h) => h.fieldName === 'resolution' && h.newValue === 'Fixed')).toBe(true);
  });

  test('unknown resolution is rejected', async () => {
    const issue = await createIssue('Bad resolution');
    await post(issue.key, { transition: { id: startTransitionId } });
    const res = await post(issue.key, { transition: { id: resolveTransitionId }, comment: 'x', fields: { resolution: { id: 99999 } } });
    expect(res.status).toBe(400);
    expect((await res.json()).validationErrors).toEqual(['Resolution not found']);
  });

  test('legacy request without resolution or comment shape still works for plain transitions', async () => {
    const issue = await createIssue('Legacy');
    const res = await post(issue.key, { transitionId: startTransitionId });
    expect(res.status).toBe(200);
  });

  test('GET /issueLinkType lists link types and requires auth', async () => {
    await clearRateLimits();
    await db.insert(schema.linkTypes).values({ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' });
    const res = await app.request('/rest/api/2/issueLinkType', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issueLinkTypes[0]).toMatchObject({ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' });
    const anon = await app.request('/rest/api/2/issueLinkType');
    expect(anon.status).toBe(401);
  });

  test('PUT with assignee null unassigns and parent null detaches (inline edit "clear")', async () => {
    const parent = await createIssue('Clear parent: parent');
    const child = await createIssue('Clear parent: child', { parent: { id: parent.id }, assignee: { id: seeded.user.id } });
    const put = (fields: any) =>
      app.request(`/rest/api/2/issue/${child.key}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ fields }) });

    const res1 = await put({ assignee: null });
    expect(res1.status).toBe(200);
    expect((await res1.json()).fields.assignee).toBeNull();

    const res2 = await put({ parent: null });
    expect(res2.status).toBe(200);
    expect((await res2.json()).fields.parent).toBeNull();
  });

  test('issue exposes parent key/summary and sprint', async () => {
    const parent = await createIssue('Parent issue');
    const child = await createIssue('Child issue', { parent: { id: parent.id } });
    const [board] = await db.insert(schema.boards).values({ name: 'B', type: 'scrum', projectId: seeded.project.id } as any).returning();
    const [sprint] = await db.insert(schema.sprints).values({ name: 'Sprint 1', state: 'active', boardId: board.id }).returning();
    await db.insert(schema.sprintIssues).values({ sprintId: sprint.id, issueId: child.id });

    await invalidateIssueKeyCache(child.key);
    await invalidateIssueCache(child.key);
    const res = await app.request(`/rest/api/2/issue/${child.key}`, { headers: { Cookie: cookie } });
    const body = await res.json();
    expect(body.fields.parent).toMatchObject({ id: parent.id, key: parent.key, summary: 'Parent issue' });
    expect(body.fields.sprint).toMatchObject({ id: sprint.id, name: 'Sprint 1', state: 'active' });

    const plain = await app.request(`/rest/api/2/issue/${parent.key}`, { headers: { Cookie: cookie } });
    expect((await plain.json()).fields.sprint).toBeNull();
  });
});
