/**
 * Turns issue events into agent runs and delivers them to the agent's webhook.
 *
 * Entry point: handleIssueEvent(), called from the automation event emitters (every create/update/comment/transition,
 * whatever API or module caused it). Delivery reuses the plugin transport (HMAC-SHA256 over `<ts>.<body>`, retries with
 * back-off, no redirects, SSRF guard); the outcome lands in the run log.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { decryptSecret } from '../auth/secrets';
import { agentDeliveries } from '../ops/metrics';
import { checkProjectPermission } from '../middleware/permissions';
import { disabledFeatures } from '../features';
import { assertPublicUrl } from '../plugins/ssrf';
import { postSigned } from '../plugins/transport';
import {
  ACTIVE_STATUSES, DEFAULT_MAX_CHAIN_DEPTH, clampText, extractAgentMentions, limitViolation, matchTrigger,
  newAgentMentions, nextChainDepth, type AgentLite, type EventFacts,
} from './logic';
import { expireStaleRuns, insertRun, mintRunToken, revokeRunToken, runCounts, type AgentRow, type RunRow } from './service';

export interface IssueEvent {
  event: 'issue_created' | 'issue_updated' | 'issue_commented' | 'issue_transitioned';
  issueId: number;
  projectId: number;
  userId: number;
  changes?: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
  commentId?: number;
}

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const cfg = () => ({
  timeoutMs: num('AGENTS_DELIVERY_TIMEOUT_MS', 10_000),
  retryBaseMs: num('AGENTS_RETRY_BASE_MS', 1000),
  maxAttempts: Math.max(1, num('AGENTS_MAX_ATTEMPTS', 3)),
  failureThreshold: Math.max(1, num('AGENTS_FAILURE_THRESHOLD', 20)),
  maxChainDepth: num('AGENTS_MAX_CHAIN_DEPTH', DEFAULT_MAX_CHAIN_DEPTH),
});

/** Tests inject a fake fetch here. */
let fetchImpl: typeof fetch | undefined;
export function setAgentFetch(f: typeof fetch | undefined) { fetchImpl = f; }

const pending = new Set<Promise<void>>();
/** Await all in-flight agent deliveries (tests, graceful shutdown). */
export async function flushAgentDeliveries(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
function track(p: Promise<void>) {
  const q = p.catch((e) => console.error('[agents] delivery failed:', e instanceof Error ? e.message : 'error'));
  pending.add(q);
  void q.finally(() => pending.delete(q));
}

/** Never throws and never blocks the request that caused the event. */
export async function handleIssueEvent(ev: IssueEvent): Promise<void> {
  try {
    await handle(ev);
  } catch (e) {
    console.error('[agents] event handling failed:', e instanceof Error ? e.message : 'error');
  }
}

async function handle(ev: IssueEvent): Promise<void> {
  const agentRows = await db.select({ agent: schema.agents, user: schema.users }).from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId)).where(eq(schema.agents.enabled, true));
  if (agentRows.length === 0) return;
  if ((await disabledFeatures()).has('agents')) return;

  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, ev.issueId)).limit(1);
  if (!issue) return;

  // Facts about the event. Text that mentions agents counts only when it is new (a comment, a new or edited description).
  let mentioned: string[] = [];
  let commented = false;
  if (ev.event === 'issue_commented' && ev.commentId) {
    const [cm] = await db.select().from(schema.comments).where(eq(schema.comments.id, ev.commentId)).limit(1);
    // Internal notes are for service desk staff only: they never reach an agent.
    if (!cm || cm.isInternal) return;
    commented = true;
    mentioned = extractAgentMentions(cm.body);
  } else if (ev.event === 'issue_created') {
    mentioned = extractAgentMentions(issue.description);
  } else if (ev.event === 'issue_updated') {
    const d = ev.changes?.find((c) => c.field === 'description');
    if (d) mentioned = newAgentMentions(d.oldValue, d.newValue);
  }
  const fields = new Set((ev.changes ?? []).map((c) => c.field));
  const facts: EventFacts = {
    actorUserId: ev.userId,
    assigneeUserId: issue.assigneeId ?? null,
    assigneeChanged: ev.event === 'issue_created' ? issue.assigneeId != null : fields.has('assignee'),
    statusChanged: ev.event === 'issue_transitioned' || fields.has('status'),
    commented,
    mentioned,
  };

  // Loop protection: who acted? If it is an agent, find how deep in a chain of agent-started work this is.
  const actorAgent = agentRows.find((r) => r.agent.userId === ev.userId);
  let actorRunDepth: number | null = null;
  if (actorAgent) {
    const [r] = await db.select({ d: schema.agentRuns.chainDepth }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.agentId, actorAgent.agent.id), eq(schema.agentRuns.issueId, ev.issueId), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES])))
      .orderBy(desc(schema.agentRuns.id)).limit(1);
    actorRunDepth = r?.d ?? null;
  }
  const chainDepth = nextChainDepth(!!actorAgent, actorRunDepth);

  let staleChecked = false;
  for (const { agent, user } of agentRows) {
    const lite: AgentLite = { id: agent.id, userId: agent.userId, username: user.username, enabled: agent.enabled, triggers: agent.triggers };
    const trigger = matchTrigger(lite, facts);
    if (!trigger) continue;
    // The agent may only be told about issues it could read itself (permission scheme / roles, same as for any user).
    if (!(await checkProjectPermission(user, issue.projectId, 'BROWSE_PROJECTS'))) continue;

    if (!staleChecked) { await expireStaleRuns(); staleChecked = true; }
    const counts = await runCounts(agent.id, issue.id);
    const c = cfg();
    const reason = limitViolation({
      chainDepth, maxChainDepth: c.maxChainDepth, ...counts,
      maxConcurrentRuns: agent.maxConcurrentRuns, maxRunsPerIssue: agent.maxRunsPerIssue, maxRunsPerHour: agent.maxRunsPerHour,
    });
    const run = await insertRun({ agentId: agent.id, issueId: issue.id, projectId: issue.projectId, trigger, triggeredBy: ev.userId, chainDepth, skipped: reason ?? undefined });
    if (reason) continue;
    if (agent.webhookUrl) track(deliverRun(run.id, ev.commentId));
    // Without a webhook the run stays queued: the agent pulls it with POST /rest/api/2/agent-runs (claim).
  }
}

/** The minimal issue snapshot sent to (and returned to) an agent. Text fields are untrusted input and are labelled as such. */
export async function buildSnapshot(issueId: number, commentId?: number) {
  const [row] = await db.select({ issue: schema.issues, project: schema.projects, status: schema.statuses, type: schema.issueTypes })
    .from(schema.issues)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .where(eq(schema.issues.id, issueId)).limit(1);
  if (!row) return null;
  const [priority] = row.issue.priorityId ? await db.select({ name: schema.priorities.name }).from(schema.priorities).where(eq(schema.priorities.id, row.issue.priorityId)).limit(1) : [];
  const ids = [row.issue.assigneeId, row.issue.reporterId].filter((x): x is number => !!x);
  const people = ids.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  const person = (id: number | null) => { const p = people.find((x) => x.id === id); return p ? { displayName: p.displayName, username: p.username } : null; };
  let comment: Record<string, unknown> | undefined;
  if (commentId) {
    const [cm] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId)).limit(1);
    if (cm && !cm.isInternal) {
      const [au] = cm.authorId ? await db.select({ displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, cm.authorId)).limit(1) : [];
      comment = { id: cm.id, author: au ?? null, body: clampText(cm.body, 2000), created: cm.createdAt };
    }
  }
  const web = process.env.WEB_URL || 'http://localhost:3001';
  return {
    issue: {
      id: row.issue.id, key: row.issue.issueKey, summary: row.issue.summary, description: clampText(row.issue.description, 2000),
      status: row.status.name, statusCategory: row.status.category, type: row.type.name, priority: priority?.name ?? null,
      assignee: person(row.issue.assigneeId), reporter: person(row.issue.reporterId),
      project: { id: row.project.id, key: row.project.projectKey, name: row.project.name },
      url: `${web}/issues/${row.issue.issueKey}`,
    },
    ...(comment ? { comment } : {}),
    untrustedFields: ['issue.summary', 'issue.description', 'comment.body'],
  };
}

async function failRun(run: RunRow, agent: AgentRow, error: string, attempts: number) {
  agentDeliveries.inc({ result: 'failure' });
  await db.update(schema.agentRuns).set({ status: 'failed', error: clampText(error, 500), attempts, tokenHash: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, run.id), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]))); // not if it was stopped meanwhile
  const [row] = await db.update(schema.agents).set({ consecutiveFailures: agent.consecutiveFailures + 1, updatedAt: new Date() }).where(eq(schema.agents.id, agent.id)).returning({ n: schema.agents.consecutiveFailures });
  if (row && row.n >= cfg().failureThreshold) {
    // Circuit breaker: a dead endpoint must not keep accumulating failed runs.
    await db.update(schema.agents).set({ enabled: false }).where(eq(schema.agents.id, agent.id));
    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, agent.userId));
    await db.update(schema.agentRuns).set({ status: 'cancelled', error: 'Agent disabled automatically after repeated delivery failures', tokenHash: null, finishedAt: new Date() })
      .where(and(eq(schema.agentRuns.agentId, agent.id), inArray(schema.agentRuns.status, ['queued', 'delivered'])));
  }
}

/** Deliver one queued run to the agent's webhook with a freshly minted scoped token. */
export async function deliverRun(runId: number, commentId?: number): Promise<void> {
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).limit(1);
  if (!run || run.status !== 'queued') return;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, run.agentId)).limit(1);
  if (!agent || !agent.enabled || !agent.webhookUrl) return;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, agent.userId)).limit(1);
  if (!user) return;
  const c = cfg();
  const deliveryId = crypto.randomUUID();
  await db.update(schema.agentRuns).set({ deliveryId, updatedAt: new Date() }).where(eq(schema.agentRuns.id, run.id));

  let started = false;
  try {
    // Re-check at delivery time: permissions may have changed since the event, and DNS may now point somewhere internal.
    if (!(await checkProjectPermission(user, run.projectId, 'BROWSE_PROJECTS'))) throw new Error('Agent no longer has access to the project');
    if (!agent.signingSecretEnc) throw new Error('Agent has no signing secret');
    const secret = decryptSecret(agent.signingSecretEnc);
    const url = (await assertPublicUrl(agent.webhookUrl)).toString();
    const snap = await buildSnapshot(run.issueId, commentId);
    if (!snap) throw new Error('Issue no longer exists');
    const { token, expiresAt } = await mintRunToken(run.id);
    started = true;
    const [triggerer] = run.triggeredBy ? await db.select({ displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, run.triggeredBy)).limit(1) : [];
    const base = process.env.API_PUBLIC_URL || process.env.WEB_URL || 'http://localhost:3001';
    const body = JSON.stringify({
      event: 'agent.run.requested',
      timestamp: new Date().toISOString(),
      deliveryId,
      run: { id: run.id, trigger: run.trigger, chainDepth: run.chainDepth },
      agent: { id: agent.id, username: user.username, displayName: user.displayName },
      triggeredBy: triggerer ?? null,
      ...snap,
      api: {
        baseUrl: base.replace(/\/+$/, ''),
        token,
        tokenExpiresAt: expiresAt.toISOString(),
        // The token authenticates as the agent, limited to this run's issue and project: read, comment, transition, report.
        capabilities: ['read:issue', 'comment:issue', 'transition:issue', 'report:run'],
        runUrl: `/rest/api/2/agent-runs/${run.id}`,
      },
    });
    const r = await postSigned({
      url, secret, event: 'agent.run.requested', deliveryId, body, userAgent: 'Veqsio-Agent/1.0', fetchImpl,
      timeoutMs: c.timeoutMs, maxAttempts: c.maxAttempts, retryBaseMs: c.retryBaseMs,
    });
    if (r.ok) {
      agentDeliveries.inc({ result: 'success' });
      // The run may have been stopped while the request was in flight: do not resurrect it.
      await db.update(schema.agentRuns).set({ status: 'delivered', attempts: r.attempts, updatedAt: new Date() })
        .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.status, 'queued')));
      if (agent.consecutiveFailures > 0) await db.update(schema.agents).set({ consecutiveFailures: 0 }).where(eq(schema.agents.id, agent.id));
    } else {
      await failRun(run, agent, `Delivery failed: ${r.error ?? 'unknown error'}`, r.attempts);
    }
  } catch (e) {
    if (started) await revokeRunToken(run.id);
    await failRun(run, agent, `Delivery failed: ${e instanceof Error ? e.message : 'error'}`, 0);
  }
}
