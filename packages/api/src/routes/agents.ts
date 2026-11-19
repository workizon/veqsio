/**
 * AI agents as first-class users: administration, per-issue run log, the run API agents call back with, and the human Stop action.
 *
 *   /rest/api/2/admin/agents/...            system administrators (create, edit, enable/disable, delete, secrets, tokens, run overview)
 *   /rest/api/2/project/:key/agents         project administrators (agents with access to the project + recent runs)
 *   /rest/api/2/issue/:idOrKey/agent-runs   anyone who can browse the issue (run log for the "Agents" section)
 *   /rest/api/2/agent-runs/...              the agent itself (claim, started, progress, finished, token) and humans (stop, read)
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { checkProjectPermission, requireIssueAccess, requireProjectPermission } from '../middleware/permissions';
import { hashToken, generateToken, expiryPolicy } from './tokens';
import { getAgentByUserId } from '../agents/auth';
import {
  ACTIVE_STATUSES, AGENT_TRIGGERS, SLUG_RE, canReport, clampText, isAgentUsername, isHttpUrl, limitViolation, nextChainDepth,
} from '../agents/logic';
import {
  AgentError, cancelActiveRuns, createAgent, deleteAgent, expireStaleRuns, insertRun, listAgentTokens, listAgents, loadAgent, mintRunToken,
  recentRuns, rotateSigningSecret, runCounts, runView, runsForIssue, setEnabled, updateAgent, viewOf, type RunRow,
} from '../agents/service';
import { buildSnapshot } from '../agents/dispatch';
import { notifyCommentAdded } from '../services/notifications';
import { publishIssueById } from '../realtime/publish';

const app = new Hono<AppContext>();
const ADMIN = '/rest/api/2/admin/agents';
const RUNS = '/rest/api/2/agent-runs';
const AGENT_SCOPES = ['read:issues', 'write:issues', 'read:projects', 'write:projects'] as const;

app.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ errorMessages: [err.message] }, err.status);
  throw err;
});

/** System administrators only; agent principals are refused outright (defence in depth on top of token scopes). */
const adminOnly = [
  requireAuth,
  createMiddleware<AppContext>(async (c, next) => {
    if (isAgentUsername(c.get('user')?.username)) return c.json({ errorMessages: ['Agents cannot call administration endpoints'] }, 403);
    await next();
  }),
  requireGlobalPermission('ADMINISTER'),
] as const;

const positiveId = (raw: string, what: string) => {
  if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 0) throw new AgentError(404, `${what} not found`);
  return Number(raw);
};
const agentId = (c: { req: { param: (k: string) => string } }) => positiveId(c.req.param('agent'), 'Agent');
const runId = (c: { req: { param: (k: string) => string } }) => positiveId(c.req.param('run'), 'Run');

const httpUrl = z.string().max(2048).refine(isHttpUrl, 'Must be an http(s) URL without credentials');
const limitsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(100).optional(),
  maxRunsPerIssue: z.number().int().min(1).max(20).optional(),
  maxRunsPerHour: z.number().int().min(1).max(10_000).optional(),
}).strict();
const triggersSchema = z.array(z.enum(AGENT_TRIGGERS)).max(AGENT_TRIGGERS.length);

async function assertOwner(ownerId: number) {
  const [o] = await db.select({ id: schema.users.id, username: schema.users.username, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, ownerId)).limit(1);
  if (!o || o.active === false || isAgentUsername(o.username) || o.username.startsWith('plugin:')) throw new AgentError(400, 'The owner must be an active human user');
}

/* ------------------------------ administration ------------------------------ */

app.get(ADMIN, ...adminOnly, async (c) => c.json(await listAgents()));

const createSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Use 2-64 lower-case letters, digits, "-" or "_"'),
  displayName: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  avatarUrl: httpUrl.nullable().optional(),
  ownerId: z.number().int().positive().optional(),
  webhookUrl: z.string().url().max(2048).nullable().optional(),
  triggers: triggersSchema.optional(),
  limits: limitsSchema.optional(),
}).strict();

app.post(ADMIN, ...adminOnly, zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');
  const ownerId = body.ownerId ?? c.get('user')!.id;
  await assertOwner(ownerId);
  const { id, signingSecret } = await createAgent({ ...body, ownerId });
  // The signing secret is shown exactly once; it is stored encrypted and only used to sign deliveries.
  return c.json({ ...(await viewOf(id)), signingSecret }, 201);
});

// Fixed paths before /:agent
app.get(`${ADMIN}/runs`, ...adminOnly, async (c) => {
  const status = c.req.query('status');
  const agent = c.req.query('agent');
  return c.json(await recentRuns({
    status: status && /^[a-z]{1,16}$/.test(status) ? status : undefined,
    agentId: agent && /^\d{1,9}$/.test(agent) ? Number(agent) : undefined,
    limit: Number(c.req.query('limit')) || 50,
  }));
});

app.get(`${ADMIN}/:agent`, ...adminOnly, async (c) => c.json(await viewOf(agentId(c))));

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  avatarUrl: httpUrl.nullable().optional(),
  ownerId: z.number().int().positive().optional(),
  webhookUrl: z.string().url().max(2048).nullable().optional(),
  triggers: triggersSchema.optional(),
  limits: limitsSchema.optional(),
}).strict();

app.put(`${ADMIN}/:agent`, ...adminOnly, zValidator('json', updateSchema), async (c) => {
  const id = agentId(c);
  const body = c.req.valid('json');
  if (body.ownerId !== undefined) await assertOwner(body.ownerId);
  await updateAgent(id, body);
  return c.json(await viewOf(id));
});

app.post(`${ADMIN}/:agent/enable`, ...adminOnly, async (c) => { const id = agentId(c); await setEnabled(id, true); return c.json(await viewOf(id)); });
app.post(`${ADMIN}/:agent/disable`, ...adminOnly, async (c) => { const id = agentId(c); await setEnabled(id, false); return c.json(await viewOf(id)); });
app.delete(`${ADMIN}/:agent`, ...adminOnly, async (c) => { await deleteAgent(agentId(c)); return c.body(null, 204); });
app.post(`${ADMIN}/:agent/signing-secret`, ...adminOnly, async (c) => c.json({ signingSecret: await rotateSigningSecret(agentId(c)) }));

app.get(`${ADMIN}/:agent/runs`, ...adminOnly, async (c) => {
  const id = agentId(c);
  await loadAgent(id);
  return c.json(await recentRuns({ agentId: id, limit: Number(c.req.query('limit')) || 50 }));
});

app.get(`${ADMIN}/:agent/tokens`, ...adminOnly, async (c) => {
  const { agent } = await loadAgent(agentId(c));
  return c.json(await listAgentTokens(agent.userId));
});

const tokenSchema = z.object({
  name: z.string().trim().min(1).max(255).default('Agent token'),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(AGENT_SCOPES.length).default(['read:issues', 'write:issues']),
  expiresInDays: z.number().int().min(1).optional(),
}).strict();

app.post(`${ADMIN}/:agent/tokens`, ...adminOnly, zValidator('json', tokenSchema), async (c) => {
  const { agent } = await loadAgent(agentId(c));
  const body = c.req.valid('json');
  const policy = expiryPolicy();
  const days = body.expiresInDays ?? policy.defaultDays;
  if (days > policy.maxDays) return c.json({ errorMessages: [`Tokens may be valid for at most ${policy.maxDays} days`] }, 400);
  const plain = generateToken();
  const scopes = [...new Set(body.scopes)];
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const [row] = await db.insert(schema.personalAccessTokens).values({ userId: agent.userId, name: body.name, tokenHash: hashToken(plain), scopes, expiresAt }).returning({ id: schema.personalAccessTokens.id });
  return c.json({ id: row.id, token: plain, name: body.name, scopes, expiresAt }, 201); // shown once
});

app.delete(`${ADMIN}/:agent/tokens/:token`, ...adminOnly, async (c) => {
  const { agent } = await loadAgent(agentId(c));
  const tokenId = positiveId(c.req.param('token'), 'Token');
  await db.update(schema.personalAccessTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.personalAccessTokens.id, tokenId), eq(schema.personalAccessTokens.userId, agent.userId)));
  return c.body(null, 204);
});

/* ------------------------------ project view ------------------------------ */

app.get('/rest/api/2/project/:key/agents', requireAuth, requireProjectPermission('ADMINISTER_PROJECTS'), async (c) => {
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key'))).limit(1);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  const rows = await db.select({ agent: schema.agents, user: schema.users }).from(schema.agents).innerJoin(schema.users, eq(schema.users.id, schema.agents.userId));
  const visible = [];
  for (const r of rows) {
    if (await checkProjectPermission(r.user, project.id, 'BROWSE_PROJECTS')) {
      visible.push({ id: r.agent.id, username: r.user.username, displayName: r.user.displayName, avatarUrl: r.user.avatarUrl, description: r.agent.description, enabled: r.agent.enabled, isAgent: true });
    }
  }
  const all = await recentRuns({ projectIds: [project.id], limit: 20 });
  return c.json({ agents: visible, recentRuns: all });
});

/* ------------------------------ issue run log ------------------------------ */

app.get('/rest/api/2/issue/:idOrKey/agent-runs', requireAuth, requireIssueAccess(), async (c) => {
  const ref = c.req.param('idOrKey');
  const [issue] = await db.select({ id: schema.issues.id }).from(schema.issues)
    .where(/^\d{1,9}$/.test(ref) ? eq(schema.issues.id, Number(ref)) : eq(schema.issues.issueKey, ref)).limit(1);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  return c.json(await runsForIssue(issue.id));
});

/* ------------------------------ run API ------------------------------ */

async function selfAgent(c: { get: (k: 'user') => typeof schema.users.$inferSelect | null }) {
  const u = c.get('user');
  if (!u || !isAgentUsername(u.username)) return null;
  return getAgentByUserId(u.id);
}

async function ownRun(c: any): Promise<{ run: RunRow; agent: NonNullable<Awaited<ReturnType<typeof selfAgent>>> }> {
  const agent = await selfAgent(c);
  if (!agent) throw new AgentError(403, 'Only agents can report on runs');
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId(c))).limit(1);
  // Other agents' runs look exactly like missing runs.
  if (!run || run.agentId !== agent.id) throw new AgentError(404, 'Run not found');
  return { run, agent };
}

app.get(RUNS, requireAuth, async (c) => {
  const agent = await selfAgent(c);
  if (!agent) return c.json({ errorMessages: ['Only agents can list their own runs here; see the issue view or Administration > AI agents'] }, 403);
  const status = c.req.query('status');
  const rows = await db.select().from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, agent.id), ...(status && /^[a-z]{1,16}$/.test(status) ? [eq(schema.agentRuns.status, status)] : [])))
    .orderBy(desc(schema.agentRuns.id)).limit(Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100));
  const out = [];
  for (const r of rows) {
    const [iss] = await db.select({ key: schema.issues.issueKey }).from(schema.issues).where(eq(schema.issues.id, r.issueId)).limit(1);
    out.push(runView(r, { issueKey: iss?.key }));
  }
  return c.json(out);
});

const claimSchema = z.object({ issue: z.string().min(1).max(100).optional(), runId: z.number().int().positive().optional() }).strict();

/** Inbound path: an agent claims a queued run (pull mode) or starts a run on an issue assigned to it. Returns the snapshot and a run token. */
app.post(RUNS, requireAuth, zValidator('json', claimSchema), async (c) => {
  const agent = await selfAgent(c);
  if (!agent) return c.json({ errorMessages: ['Only agents can claim runs'] }, 403);
  const user = c.get('user')!;
  if (c.get('agentRun')) return c.json({ errorMessages: ['A run token cannot claim further runs'] }, 403);
  const body = c.req.valid('json');
  await expireStaleRuns();

  let ref: number | null = null;
  if (body.issue) {
    const [iss] = await db.select({ id: schema.issues.id }).from(schema.issues)
      .where(/^\d{1,9}$/.test(body.issue) ? eq(schema.issues.id, Number(body.issue)) : eq(schema.issues.issueKey, body.issue.toUpperCase())).limit(1);
    if (!iss) return c.json({ errorMessages: ['Issue not found'] }, 404);
    ref = iss.id;
  }

  // 1. an existing queued run (never delivered by webhook)
  const queued = await db.select().from(schema.agentRuns).where(and(
    eq(schema.agentRuns.agentId, agent.id), eq(schema.agentRuns.status, 'queued'),
    ...(body.runId ? [eq(schema.agentRuns.id, body.runId)] : []), ...(ref ? [eq(schema.agentRuns.issueId, ref)] : []),
  )).orderBy(schema.agentRuns.id).limit(20);
  let chosen: RunRow | null = null;
  for (const r of queued) {
    if (r.deliveryId) continue; // a webhook delivery is in flight for this one
    if (!(await checkProjectPermission(user, r.projectId, 'BROWSE_PROJECTS'))) continue;
    chosen = r;
    break;
  }
  if (chosen) {
    const [claimed] = await db.update(schema.agentRuns).set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.agentRuns.id, chosen.id), eq(schema.agentRuns.status, 'queued'))).returning();
    if (!claimed) return c.json({ errorMessages: ['The run was claimed by someone else'] }, 409);
    chosen = claimed;
  } else {
    if (body.runId || !ref) return c.json({ errorMessages: ['No queued run to claim'] }, 404);
    // 2. no queued run: start one on an issue that is assigned to this agent
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, ref)).limit(1);
    if (!issue || !(await checkProjectPermission(user, issue.projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Issue not found'] }, 404);
    if (issue.assigneeId !== user.id) return c.json({ errorMessages: ['The issue is not assigned to this agent'] }, 403);
    const counts = await runCounts(agent.id, issue.id);
    const reason = limitViolation({
      chainDepth: nextChainDepth(false, null), maxChainDepth: 99, ...counts,
      maxConcurrentRuns: agent.maxConcurrentRuns, maxRunsPerIssue: agent.maxRunsPerIssue, maxRunsPerHour: agent.maxRunsPerHour,
    });
    if (reason) return c.json({ errorMessages: [`Not started: ${reason}`] }, 429);
    const created = await insertRun({ agentId: agent.id, issueId: issue.id, projectId: issue.projectId, trigger: 'claim', triggeredBy: user.id, chainDepth: 0, status: 'running' });
    const [started] = await db.update(schema.agentRuns).set({ startedAt: new Date() }).where(eq(schema.agentRuns.id, created.id)).returning();
    chosen = started;
  }
  const { token, expiresAt } = await mintRunToken(chosen.id);
  const snap = await buildSnapshot(chosen.issueId);
  return c.json({ run: runView(chosen), ...(snap ?? {}), api: { token, tokenExpiresAt: expiresAt, runUrl: `${RUNS}/${chosen.id}` } }, 201);
});

app.get(`${RUNS}/:run`, requireAuth, async (c) => {
  const id = runId(c);
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).limit(1);
  const user = c.get('user')!;
  if (!run) return c.json({ errorMessages: ['Run not found'] }, 404);
  const self = await selfAgent(c);
  if (self ? self.id !== run.agentId : !(await checkProjectPermission(user, run.projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Run not found'] }, 404);
  return c.json(runView(run));
});

/** Human Stop: marks the run cancelled and kills its short-lived token at once. */
app.post(`${RUNS}/:run/stop`, requireAuth, async (c) => {
  const user = c.get('user')!;
  if (isAgentUsername(user.username)) return c.json({ errorMessages: ['Agents cannot stop runs; report finished instead'] }, 403);
  const id = runId(c);
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).limit(1);
  if (!run || !(await checkProjectPermission(user, run.projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Run not found'] }, 404);
  if (!(await checkProjectPermission(user, run.projectId, 'EDIT_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const [stopped] = await db.update(schema.agentRuns)
    .set({ status: 'cancelled', error: clampText(`Stopped by ${user.displayName}`, 500), tokenHash: null, tokenExpiresAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, id), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]))).returning();
  if (!stopped) return c.json({ errorMessages: [`The run already ${run.status === 'cancelled' ? 'was cancelled' : 'ended (' + run.status + ')'}`] }, 409);
  publishIssueById('issue.updated', run.issueId, user.id);
  return c.json(runView(stopped));
});

async function guardReport(run: RunRow, action: 'started' | 'progress' | 'finished') {
  if (!canReport(run.status as any, action)) throw new AgentError(409, `The run is ${run.status}${run.status === 'cancelled' ? ' (stopped)' : ''}; stop working on it`);
}

app.post(`${RUNS}/:run/started`, requireAuth, zValidator('json', z.object({}).strict().default({})), async (c) => {
  const { run } = await ownRun(c);
  await guardReport(run, 'started');
  const [row] = await db.update(schema.agentRuns)
    .set({ status: 'running', startedAt: run.startedAt ?? new Date(), updatedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, run.id), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]))).returning();
  if (!row) throw new AgentError(409, 'The run is no longer active');
  return c.json(runView(row));
});

/** Posts a comment as the agent through the same rules as a human comment (ADD_COMMENTS), then notifies. */
async function postAgentComment(agentUser: typeof schema.users.$inferSelect, run: RunRow, text: string) {
  if (!(await checkProjectPermission(agentUser, run.projectId, 'ADD_COMMENTS'))) throw new AgentError(403, 'The agent may not comment in this project');
  const [comment] = await db.insert(schema.comments).values({ issueId: run.issueId, body: text, authorId: agentUser.id, isInternal: false }).returning();
  publishIssueById('comment.added', run.issueId, agentUser.id);
  const { emitIssueCommented } = await import('../services/automation-engine');
  await emitIssueCommented(run.issueId, agentUser.id, comment.id);
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, run.issueId)).limit(1);
  try { if (issue) await notifyCommentAdded(comment, issue); } catch (e) { console.error('[agents] comment notification failed:', e instanceof Error ? e.message : 'error'); }
  return comment.id;
}

const progressSchema = z.object({ note: z.string().trim().min(1).max(4000), comment: z.boolean().optional() }).strict();
app.post(`${RUNS}/:run/progress`, requireAuth, zValidator('json', progressSchema), async (c) => {
  const { run } = await ownRun(c);
  await guardReport(run, 'progress');
  const body = c.req.valid('json');
  let commentId: number | null = null;
  if (body.comment) commentId = await postAgentComment(c.get('user')!, run, body.note);
  const [row] = await db.update(schema.agentRuns)
    .set({ status: 'running', startedAt: run.startedAt ?? new Date(), summary: clampText(body.note, 2000), updatedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, run.id), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]))).returning();
  if (!row) throw new AgentError(409, 'The run is no longer active');
  return c.json({ ...runView(row), commentId });
});

const finishedSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  summary: z.string().trim().max(4000).optional(),
  resultUrl: httpUrl.optional(),
  error: z.string().max(1000).optional(),
  comment: z.boolean().optional(),
}).strict();
app.post(`${RUNS}/:run/finished`, requireAuth, zValidator('json', finishedSchema), async (c) => {
  const { run } = await ownRun(c);
  await guardReport(run, 'finished');
  const body = c.req.valid('json');
  if (body.comment && body.summary) await postAgentComment(c.get('user')!, run, body.summary);
  const [row] = await db.update(schema.agentRuns)
    .set({
      status: body.status, summary: clampText(body.summary ?? run.summary, 4000), resultUrl: body.resultUrl ?? null,
      error: body.status === 'failed' ? clampText(body.error ?? 'Reported as failed by the agent', 1000) : null,
      tokenHash: null, tokenExpiresAt: null, finishedAt: new Date(), updatedAt: new Date(),
    })
    .where(and(eq(schema.agentRuns.id, run.id), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]))).returning();
  if (!row) throw new AgentError(409, 'The run is no longer active');
  return c.json(runView(row));
});

/** A fresh short-lived token for a run that is still active (long jobs). Works with the agent's long-lived token or a still valid run token. */
app.post(`${RUNS}/:run/token`, requireAuth, async (c) => {
  const { run } = await ownRun(c);
  if (run.status === 'queued' || !canReport(run.status as any, 'progress')) throw new AgentError(409, `The run is ${run.status}`);
  const { token, expiresAt } = await mintRunToken(run.id);
  return c.json({ token, tokenExpiresAt: expiresAt });
});

export default app;
