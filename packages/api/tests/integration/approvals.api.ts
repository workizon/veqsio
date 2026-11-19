import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { and, eq, like } from 'drizzle-orm';
import app from '../../src/app';
import { redis } from '../../src/services/cache';
import { resetRateLimits } from '../reset-rate-limits';
import { runApprovalJobs } from '../../src/approvals/reminders';

describe('Approvals', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;
  const cookies: Record<string, string> = {};
  const uid: Record<string, number> = {};
  const T: Record<string, number> = {}; // transition ids
  const S: Record<string, number> = {}; // status ids
  let deskId = 0;

  const call = (who: string | null, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return res.headers.get('set-cookie') || '';
  };

  async function newIssue(summary: string, priorityId?: number) {
    const res = await call('admin', 'POST', '/rest/api/2/issue', {
      fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary },
    });
    expect(res.status).toBe(201);
    const issue = (await res.json()) as { id: number; key: string };
    if (priorityId) await db.update(schema.issues).set({ priorityId }).where(eq(schema.issues.id, issue.id));
    return issue;
  }

  const transition = (who: string, key: string, id: number, fields: any = {}) =>
    call(who, 'POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id }, fields });

  const statusOf = async (id: number) => {
    const [i] = await db.select().from(schema.issues).where(eq(schema.issues.id, id));
    return i.statusId;
  };

  const approvalsOf = async (issueId: number) => db.select().from(schema.approvals).where(eq(schema.approvals.issueId, issueId)).orderBy(schema.approvals.id);

  async function template(name: string, extra: Record<string, unknown> = {}) {
    const res = await call('padmin', 'POST', '/rest/api/2/project/TEST/approval-template', {
      name, approverUserIds: [uid.appr1, uid.appr2], rule: 'all', ...extra,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number };
  }

  async function transitionTo(name: string, from: number, to: number, validators: any[] = [], postFunctions: any[] = []) {
    const [t] = await db.insert(schema.workflowTransitions).values({
      workflowId: seeded.workflow.id, name, fromStatusId: from, toStatusId: to, conditions: [{ type: 'always_true' }], validators, postFunctions,
    }).returning();
    T[name] = t.id;
  }

  beforeAll(async () => {
    await resetRateLimits();
    for (let id = 1; id <= 40; id++) await redis.del(`veqsio:portal-limit:apdec:${id}`);
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    uid.admin = seeded.user.id;
    for (const n of ['agent', 'padmin', 'appr1', 'appr2', 'appr3', 'outsider', 'cust1', 'cust2', 'cust3', 'rl']) {
      const [u] = await db.insert(schema.users).values({ username: n, email: `${n}@example.com`, displayName: n, passwordHash: hash }).returning();
      uid[n] = u.id;
    }
    for (const n of ['admin', 'agent', 'padmin', 'appr1', 'appr2', 'appr3', 'outsider', 'cust1', 'cust2', 'cust3', 'rl']) cookies[n] = await login(n);

    // Project permissions: agents browse + transition, project admin browse + admin; approvers have nothing on purpose.
    const entries = [
      ['agent', 'BROWSE_PROJECTS'], ['agent', 'TRANSITION_ISSUES'],
      ['padmin', 'BROWSE_PROJECTS'], ['padmin', 'PROJECT_ADMIN'], ['padmin', 'TRANSITION_ISSUES'],
    ] as const;
    for (const [u, p] of entries) await db.insert(schema.permissionEntries).values({ schemeId: seeded.permScheme.id, permissionKey: p, userId: uid[u] });

    // Workflow: To Do -> Waiting (requests approval) -> Approved / Auto ...
    for (const n of ['Waiting', 'Approved', 'Auto approved', 'Auto rejected', 'Stuck']) {
      const [s] = await db.insert(schema.statuses).values({ name: n, category: 'in_progress' }).returning();
      S[n] = s.id;
    }
    const todo = seeded.status.id;
    await transitionTo('gate', S.Waiting, S.Approved, [{ type: 'approval_required' }]);
    await transitionTo('auto-ok', S.Waiting, S['Auto approved']);
    await transitionTo('auto-no', S.Waiting, S['Auto rejected'], [{ type: 'approval_required' }]); // the approval validator is skipped for system actors
    await transitionTo('auto-blocked', S.Waiting, S.Stuck, [{ type: 'field_required', field: 'resolution' }]);

    deskId = 0;
    void todo;
  });

  afterAll(async () => {
    delete process.env.APPROVAL_MAX_DECISIONS_PER_HOUR;
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ------------------------------ templates ------------------------------ */

  test('template CRUD: only project admins write, agents read a summary, strangers see nothing', async () => {
    const body = { name: 'CrudTpl', approverUserIds: [uid.appr1, uid.appr2], rule: 'all' };
    expect((await call(null, 'POST', '/rest/api/2/project/TEST/approval-template', body)).status).toBe(401);
    expect((await call('outsider', 'POST', '/rest/api/2/project/TEST/approval-template', body)).status).toBe(404);
    expect((await call('agent', 'POST', '/rest/api/2/project/TEST/approval-template', body)).status).toBe(403);
    const created = await call('padmin', 'POST', '/rest/api/2/project/TEST/approval-template', body);
    expect(created.status).toBe(201);
    const tpl = await created.json();
    expect((await call('padmin', 'POST', '/rest/api/2/project/TEST/approval-template', body)).status).toBe(409);

    const asAgent = await (await call('agent', 'GET', '/rest/api/2/project/TEST/approval-template')).json();
    expect(asAgent.values[0].name).toBe('CrudTpl');
    expect(asAgent.values[0].approverUserIds).toBeUndefined();
    const asAdmin = await (await call('padmin', 'GET', '/rest/api/2/project/TEST/approval-template')).json();
    expect(asAdmin.values[0].approverUserIds).toEqual([uid.appr1, uid.appr2]);
    expect((await call('outsider', 'GET', '/rest/api/2/project/TEST/approval-template')).status).toBe(404);

    expect((await call('agent', 'PUT', `/rest/api/2/project/TEST/approval-template/${tpl.id}`, { rule: 'any' })).status).toBe(403);
    const upd = await call('padmin', 'PUT', `/rest/api/2/project/TEST/approval-template/${tpl.id}`, { rule: 'any', reminderIntervalHours: 4 });
    expect(upd.status).toBe(200);
    expect((await upd.json()).rule).toBe('any');
    expect((await call('padmin', 'PUT', `/rest/api/2/project/TEST/approval-template/${tpl.id}`, { rule: 'all' })).status).toBe(200);
    expect((await call('agent', 'DELETE', `/rest/api/2/project/TEST/approval-template/${tpl.id}`)).status).toBe(403);
    expect((await call('padmin', 'DELETE', `/rest/api/2/project/TEST/approval-template/${tpl.id}`)).status).toBe(204);
    expect((await call('padmin', 'DELETE', `/rest/api/2/project/TEST/approval-template/${tpl.id}`)).status).toBe(404);
  });

  test('template validation: strict keys, rules, unknown references', async () => {
    const post = (b: unknown) => call('padmin', 'POST', '/rest/api/2/project/TEST/approval-template', b);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], bogus: 1 })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [] })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], rule: 'n_of_m' })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], rule: 'n_of_m', ruleThreshold: 3 })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], rule: 'percentage', ruleThreshold: 101 })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [999999] })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], onApprovedTransitionId: 999999 })).status).toBe(400);
    expect((await post({ name: 'x', approverUserIds: [uid.appr1], autoApproveWhen: { field: 'summary', op: 'eq', value: 'a' } })).status).toBe(400);
    expect((await call('padmin', 'DELETE', '/rest/api/2/project/TEST/approval-template/abc')).status).toBe(404);
  });

  /* ------------------------------ requests and decisions ------------------------------ */

  test('requesting: permissions, strict body, no self-approval', async () => {
    const issue = await newIssue('Request approval permissions');
    const adhoc = { approverUserIds: [uid.appr1, uid.appr2], rule: 'all' };
    expect((await call(null, 'POST', `/rest/api/2/issue/${issue.key}/approval`, adhoc)).status).toBe(401);
    expect((await call('outsider', 'POST', `/rest/api/2/issue/${issue.key}/approval`, adhoc)).status).toBe(404);
    expect((await call('appr1', 'POST', `/rest/api/2/issue/${issue.key}/approval`, adhoc)).status).toBe(404);
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { ...adhoc, extra: 1 })).status).toBe(400);
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, {})).status).toBe(400);
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { templateId: 1, approverUserIds: [uid.appr1] })).status).toBe(400);
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.agent] })).status).toBe(400); // requester cannot approve
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [999999] })).status).toBe(400);
    expect((await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { templateId: 999999 })).status).toBe(404);
    const ok = await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { ...adhoc, name: 'Budget' });
    expect(ok.status).toBe(201);
    const a = await ok.json();
    expect(a.status).toBe('pending');
    expect(a.approvers.map((x: any) => x.id).sort()).toEqual([uid.appr1, uid.appr2].sort());
  });

  test('only an assigned approver decides, once, and only while pending', async () => {
    const issue = await newIssue('Decision rules');
    const a = await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.appr1, uid.appr2, uid.appr3], rule: 'n_of_m', ruleThreshold: 2 })).json();
    const decide = (who: string, decision: string, extra: any = {}) => call(who, 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision, ...extra });
    expect((await decide('outsider', 'approved')).status).toBe(404);
    expect((await decide('agent', 'approved')).status).toBe(404); // the requester is not an approver
    expect((await decide('admin', 'approved')).status).toBe(404); // not even a superuser: approvers only
    expect((await call(null, 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'approved' })).status).toBe(401);
    expect((await decide('appr1', 'maybe')).status).toBe(400);
    expect((await decide('appr1', 'approved', { x: 1 })).status).toBe(400);
    const first = await decide('appr1', 'approved', { comment: 'looks fine' });
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe('pending');
    expect((await decide('appr1', 'declined')).status).toBe(409); // decisions are immutable
    const second = await decide('appr2', 'approved');
    expect((await second.json()).status).toBe('approved'); // 2 of 3
    expect((await decide('appr3', 'declined')).status).toBe(409); // already completed
    const list = await (await call('agent', 'GET', `/rest/api/2/issue/${issue.key}/approval`)).json();
    expect(list.values[0].decisions.map((d: any) => d.decision)).toEqual(['approved', 'approved']);
    expect(list.values[0].decisions[0].comment).toBe('looks fine');
    // non-browsers (an approver) see only their own approval, never the other decisions
    const mine = await (await call('appr3', 'GET', `/rest/api/2/issue/${issue.key}/approval`)).json();
    expect(mine.values[0].decisions).toBeUndefined();
    expect((await call('outsider', 'GET', `/rest/api/2/issue/${issue.key}/approval`)).status).toBe(404);
  });

  test('early decline when n_of_m is no longer reachable', async () => {
    const issue = await newIssue('Early decline');
    const a = await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.appr1, uid.appr2, uid.appr3], rule: 'n_of_m', ruleThreshold: 2 })).json();
    await call('appr1', 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'declined' });
    const r = await call('appr2', 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'declined' });
    expect((await r.json()).status).toBe('declined');
  });

  test('cancel: requester or project admin only, pending only', async () => {
    const issue = await newIssue('Cancel');
    const mk = async () => (await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.appr1] })).json()).id as number;
    const a = await mk();
    expect((await call('appr1', 'DELETE', `/rest/api/2/approval/${a}`)).status).toBe(404);
    expect((await call('outsider', 'DELETE', `/rest/api/2/approval/${a}`)).status).toBe(404);
    expect((await call('agent', 'DELETE', `/rest/api/2/approval/${a}`)).status).toBe(204);
    expect((await call('agent', 'DELETE', `/rest/api/2/approval/${a}`)).status).toBe(409);
    expect((await call('appr1', 'POST', `/rest/api/2/approval/${a}/decision`, { decision: 'approved' })).status).toBe(409);
    const b = await mk();
    expect((await call('padmin', 'DELETE', `/rest/api/2/approval/${b}`)).status).toBe(204);
    expect((await call('agent', 'DELETE', '/rest/api/2/approval/abc')).status).toBe(404);
  });

  test('my pending approvals are paged and personal', async () => {
    const issue = await newIssue('Pending list');
    for (let i = 0; i < 3; i++) await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.appr3], name: `P${i}` });
    const all = await (await call('appr3', 'GET', '/rest/api/2/approval/pending')).json();
    expect(all.values.length).toBeGreaterThanOrEqual(3);
    expect(all.values[0].issue.key).toBeDefined();
    expect(all.values[0].decisions).toBeUndefined();
    const page = await (await call('appr3', 'GET', '/rest/api/2/approval/pending?maxResults=2')).json();
    expect(page.values.length).toBe(2);
    expect(page.total).toBe(all.total);
    expect(page.isLast).toBe(false);
    const none = await (await call('outsider', 'GET', '/rest/api/2/approval/pending')).json();
    expect(none.values).toEqual([]);
    expect((await call(null, 'GET', '/rest/api/2/approval/pending')).status).toBe(401);
    // cleanup so later tests start without these
    for (const v of all.values) await call('agent', 'DELETE', `/rest/api/2/approval/${v.id}`);
  });

  /* ------------------------------ workflow ------------------------------ */

  test('post-function requests an approval and the validator blocks the transition until approved', async () => {
    await template('Manager');
    await transitionTo('request-manager', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'Manager' }]);
    const issue = await newIssue('Gate');
    const t = await transition('agent', issue.key, T['request-manager']);
    expect(t.status).toBe(200);
    const [appr] = await approvalsOf(issue.id);
    expect(appr.name).toBe('Manager');
    expect(appr.status).toBe('pending');
    expect(appr.createdBy).toBe(uid.agent);

    let blocked = await transition('agent', issue.key, T.gate);
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).errorMessages[0]).toContain('pending');
    await call('appr1', 'POST', `/rest/api/2/approval/${appr.id}/decision`, { decision: 'approved' });
    blocked = await transition('agent', issue.key, T.gate);
    expect(blocked.status).toBe(400); // one of two approvals is not enough for rule "all"
    await call('appr2', 'POST', `/rest/api/2/approval/${appr.id}/decision`, { decision: 'approved' });
    expect((await transition('agent', issue.key, T.gate)).status).toBe(200);
    expect(await statusOf(issue.id)).toBe(S.Approved);
  });

  test('a declined approval keeps the transition blocked', async () => {
    const issue = await newIssue('Declined gate');
    await transition('agent', issue.key, T['request-manager']);
    const [appr] = await approvalsOf(issue.id);
    await call('appr1', 'POST', `/rest/api/2/approval/${appr.id}/decision`, { decision: 'declined' });
    const r = await transition('agent', issue.key, T.gate);
    expect(r.status).toBe(400);
    expect((await r.json()).errorMessages[0]).toContain('declined');
  });

  test('the validator also blocks when no approval was requested at all', async () => {
    const issue = await newIssue('No approval');
    await db.update(schema.issues).set({ statusId: S.Waiting }).where(eq(schema.issues.id, issue.id));
    const r = await transition('agent', issue.key, T.gate);
    expect(r.status).toBe(400);
    expect((await r.json()).errorMessages[0]).toContain('required');
  });

  test('the same post-function does not stack a second pending approval', async () => {
    const issue = await newIssue('No duplicates');
    await transition('agent', issue.key, T['request-manager']);
    await db.update(schema.issues).set({ statusId: seeded.status.id }).where(eq(schema.issues.id, issue.id));
    expect((await transition('agent', issue.key, T['request-manager'])).status).toBe(200);
    expect((await approvalsOf(issue.id)).length).toBe(1);
  });

  test('auto-transition on completion runs as a system actor and respects other validators', async () => {
    const auto = await template('Auto', { rule: 'any', onApprovedTransitionId: T['auto-ok'], onDeclinedTransitionId: T['auto-no'] });
    void auto;
    await template('AutoBlocked', { rule: 'any', onApprovedTransitionId: T['auto-blocked'] });
    await transitionTo('request-auto', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'Auto' }]);
    await transitionTo('request-blocked', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'AutoBlocked' }]);

    const ok = await newIssue('Auto approved');
    await transition('agent', ok.key, T['request-auto']);
    const [a1] = await approvalsOf(ok.id);
    await call('appr1', 'POST', `/rest/api/2/approval/${a1.id}/decision`, { decision: 'approved' });
    expect(await statusOf(ok.id)).toBe(S['Auto approved']);
    const hist = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, ok.id), eq(schema.issueHistory.fieldName, 'status'))).orderBy(schema.issueHistory.id);
    expect(hist.at(-1)!.authorId).toBeNull(); // system actor

    const no = await newIssue('Auto declined');
    await transition('agent', no.key, T['request-auto']);
    const [a2] = await approvalsOf(no.id);
    await call('appr1', 'POST', `/rest/api/2/approval/${a2.id}/decision`, { decision: 'declined' });
    await call('appr2', 'POST', `/rest/api/2/approval/${a2.id}/decision`, { decision: 'declined' });
    // declined target carries the approval validator itself: skipped for the system actor
    expect(await statusOf(no.id)).toBe(S['Auto rejected']);

    const blocked = await newIssue('Auto blocked by validator');
    await transition('agent', blocked.key, T['request-blocked']);
    const [a3] = await approvalsOf(blocked.id);
    await call('appr1', 'POST', `/rest/api/2/approval/${a3.id}/decision`, { decision: 'approved' });
    expect(await statusOf(blocked.id)).toBe(S.Waiting); // field_required(resolution) still applies, nothing was bypassed
    expect((await approvalsOf(blocked.id))[0].status).toBe('approved');
  });

  test('automatic rule approves immediately when the issue matches', async () => {
    await template('AutoMedium', { autoApproveWhen: { field: 'priority', op: 'eq', value: 'medium' } });
    await transitionTo('request-medium', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'AutoMedium' }]);
    const issue = await newIssue('Auto rule', seeded.priority.id);
    await transition('agent', issue.key, T['request-medium']);
    const [a] = await approvalsOf(issue.id);
    expect(a.status).toBe('approved');
    expect(a.completedBy).toBe('auto_rule');
    const other = await newIssue('Auto rule no match');
    await transition('agent', other.key, T['request-medium']);
    expect((await approvalsOf(other.id))[0].status).toBe('pending');
  });

  /* ------------------------------ concurrency ------------------------------ */

  test('two simultaneous last approvals complete the approval and fire the transition exactly once', async () => {
    await template('Race', { rule: 'all', onApprovedTransitionId: T['auto-ok'] });
    await transitionTo('request-race', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'Race' }]);
    const issue = await newIssue('Race all');
    await transition('agent', issue.key, T['request-race']);
    const [a] = await approvalsOf(issue.id);
    const [r1, r2] = await Promise.all(['appr1', 'appr2'].map((w) => call(w, 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'approved' })));
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await approvalsOf(issue.id))[0].status).toBe('approved');
    const hist = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issue.id), eq(schema.issueHistory.fieldName, 'status'), eq(schema.issueHistory.newValue, 'Auto approved')));
    expect(hist.length).toBe(1);
    const completions = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issue.id), eq(schema.issueHistory.newValue, 'Race: approved')));
    expect(completions.length).toBe(1);
    const mails = await db.select().from(schema.emailQueue).where(like(schema.emailQueue.subject, `Approval approved: ${issue.key}`));
    expect(mails.length).toBe(1);
  });

  test('simultaneous decisions on a rule "any" approval: one wins, the other is refused', async () => {
    await template('RaceAny', { rule: 'any', onApprovedTransitionId: T['auto-ok'] });
    await transitionTo('request-race-any', seeded.status.id, S.Waiting, [], [{ type: 'request_approval', template: 'RaceAny' }]);
    const issue = await newIssue('Race any');
    await transition('agent', issue.key, T['request-race-any']);
    const [a] = await approvalsOf(issue.id);
    const res = await Promise.all(['appr1', 'appr2'].map((w) => call(w, 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'approved' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const decisions = await db.select().from(schema.approvalDecisions).where(eq(schema.approvalDecisions.approvalId, a.id));
    expect(decisions.length).toBe(1);
    const hist = await db.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issue.id), eq(schema.issueHistory.newValue, 'Auto approved')));
    expect(hist.length).toBe(1);
  });

  /* ------------------------------ notifications, reminders, expiry ------------------------------ */

  test('approvers get an email on creation (user content escaped) and the requester one on completion', async () => {
    const issue = await newIssue('<script>alert(1)</script> approval');
    const a = await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.appr1], name: 'Mail' })).json();
    const mails = await db.select().from(schema.emailQueue).where(eq(schema.emailQueue.toAddress, 'appr1@example.com'));
    const m = mails.find((x) => x.subject === `Approval requested: ${issue.key}`)!;
    expect(m).toBeDefined();
    expect(m.htmlBody).not.toContain('<script>alert(1)</script>');
    expect(m.htmlBody).toContain('&lt;script&gt;');
    await call('appr1', 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'declined' });
    const done = await db.select().from(schema.emailQueue).where(eq(schema.emailQueue.toAddress, 'agent@example.com'));
    expect(done.some((x) => x.subject === `Approval declined: ${issue.key}`)).toBe(true);
  });

  test('reminders are sent once per interval and overdue approvals expire', async () => {
    const issue = await newIssue('Reminder');
    const a = await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, {
      approverUserIds: [uid.appr1, uid.appr2], reminderIntervalHours: 1, expiryHours: 2, name: 'Remind',
    })).json();
    const past = new Date(Date.now() - 60_000);
    await db.update(schema.approvals).set({ nextReminderAt: past }).where(eq(schema.approvals.id, a.id));
    await call('appr1', 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'approved' });
    const before = (await db.select().from(schema.emailQueue)).length; // ids only grow, so slicing by id order is safe
    const r1 = await runApprovalJobs();
    expect(r1.reminded).toBe(1);
    const reminders = (await db.select().from(schema.emailQueue).orderBy(schema.emailQueue.id)).slice(before).filter((m) => m.subject.startsWith('Reminder'));
    expect(reminders.map((m) => m.toAddress)).toEqual(['appr2@example.com']); // only the one who has not decided
    expect(reminders[0].subject).toContain('Reminder');
    expect((await runApprovalJobs()).reminded).toBe(0);
    const [row] = await approvalsOf(issue.id);
    expect(row.remindersSent).toBe(1);

    await db.update(schema.approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.approvals.id, a.id));
    expect((await runApprovalJobs()).expired).toBe(1);
    expect((await approvalsOf(issue.id))[0].status).toBe('expired');
    expect((await call('appr2', 'POST', `/rest/api/2/approval/${a.id}/decision`, { decision: 'approved' })).status).toBe(409);
  });

  test('decisions are rate limited per user', async () => {
    process.env.APPROVAL_MAX_DECISIONS_PER_HOUR = '2';
    const issue = await newIssue('Rate limit');
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await (await call('agent', 'POST', `/rest/api/2/issue/${issue.key}/approval`, { approverUserIds: [uid.rl], name: `RL${i}` })).json()).id);
    const out = [];
    for (const id of ids) out.push((await call('rl', 'POST', `/rest/api/2/approval/${id}/decision`, { decision: 'approved' })).status);
    expect(out).toEqual([200, 200, 429]);
    delete process.env.APPROVAL_MAX_DECISIONS_PER_HOUR;
  });

  test('decisions are written to the audit log without the comment text', async () => {
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'approval.decision'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('looks fine');
  });

  /* ------------------------------ portal ------------------------------ */

  test('customer approvers see and decide only approvals addressed to them', async () => {
    let res = await call('admin', 'POST', '/rest/servicedeskapi/servicedesk', { projectKey: 'TEST', name: 'Appr desk', slug: 'appr', publicSignup: true });
    expect(res.status).toBe(201);
    deskId = (await res.json()).id;
    res = await call('admin', 'POST', `/rest/servicedeskapi/servicedesk/${deskId}/requesttype`, {
      name: 'Help', issueTypeId: seeded.issueType.id, defaultPriorityId: seeded.priority.id, fields: [],
    });
    const rtId = (await res.json()).id;
    await db.insert(schema.serviceDeskAgents).values({ serviceDeskId: deskId, userId: uid.agent, role: 'agent' });
    for (const c of ['cust1', 'cust2', 'cust3']) await call(c, 'GET', '/rest/servicedeskapi/portal/appr');
    for (const id of Object.values(uid)) for (const b of ['req', 'cmt', 'upl']) await redis.del(`veqsio:portal-limit:${b}:${deskId}:${id}`);

    res = await call('cust1', 'POST', '/rest/servicedeskapi/portal/appr/request', { requestTypeId: rtId, summary: 'Need a laptop' });
    expect(res.status).toBe(201);
    const key = (await res.json()).key as string;
    // internal note that approvers must never see
    const [req] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key));
    await db.insert(schema.comments).values({ issueId: req.id, body: 'INTERNAL-ONLY-NOTE', authorId: uid.agent, isInternal: true });

    const mk = await call('agent', 'POST', `/rest/api/2/issue/${key}/approval`, { approverUserIds: [uid.cust2], name: 'Budget owner', rule: 'all' });
    expect(mk.status).toBe(201);
    const approvalId = (await mk.json()).id as number;

    const list = await (await call('cust2', 'GET', '/rest/servicedeskapi/portal/appr/approvals')).json();
    expect(list.values.length).toBe(1);
    expect(list.values[0].request).toEqual({ key, summary: 'Need a laptop' });
    expect(list.values[0].canDecide).toBe(true);
    expect(JSON.stringify(list)).not.toContain('INTERNAL-ONLY-NOTE');
    expect(list.values[0].decisions).toBeUndefined();
    expect(list.values[0].approvers).toBeUndefined();

    expect((await (await call('cust3', 'GET', '/rest/servicedeskapi/portal/appr/approvals')).json()).values).toEqual([]);
    expect((await (await call('cust1', 'GET', '/rest/servicedeskapi/portal/appr/approvals')).json()).values).toEqual([]);
    expect((await call(null, 'GET', '/rest/servicedeskapi/portal/appr/approvals')).status).toBe(401);
    expect((await call('cust2', 'GET', '/rest/servicedeskapi/portal/nope/approvals')).status).toBe(404);

    const dec = (who: string, slug = 'appr', id = approvalId) => call(who, 'POST', `/rest/servicedeskapi/portal/${slug}/approvals/${id}/decision`, { decision: 'approved', comment: 'ok' });
    expect((await dec('cust3')).status).toBe(404);
    expect((await dec('cust1')).status).toBe(404);
    expect((await dec('cust2', 'nope')).status).toBe(404);
    expect((await dec('cust2', 'appr', 999999)).status).toBe(404);
    // REST view: customers are not staff, so they get only their own approval and no decisions list
    const rest = await (await call('cust2', 'GET', `/rest/api/2/issue/${key}/approval`)).json();
    expect(rest.values.length).toBe(1);
    expect(rest.values[0].decisions).toBeUndefined();
    expect((await call('cust3', 'GET', `/rest/api/2/issue/${key}/approval`)).status).toBe(404);
    expect((await call('cust1', 'GET', `/rest/api/2/issue/${key}/approval`)).status).toBe(404);

    expect((await dec('cust2')).status).toBe(204);
    expect((await dec('cust2')).status).toBe(409);
    const after = await (await call('cust2', 'GET', `/rest/servicedeskapi/portal/appr/approvals?key=${key}`)).json();
    expect(after.values[0].status).toBe('approved');
    expect(after.values[0].myDecision.decision).toBe('approved');
    expect((await (await call('cust2', 'GET', '/rest/servicedeskapi/portal/appr/approvals')).json()).values).toEqual([]);
    expect((await (await call('cust3', 'GET', `/rest/servicedeskapi/portal/appr/approvals?key=${key}`)).json()).values).toEqual([]);
  });
});
