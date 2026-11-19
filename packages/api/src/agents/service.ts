/** Agent registry and run log operations. No agent code ever runs here; agents are external HTTP services. */
import { randomBytes } from 'crypto';
import { and, desc, eq, gt, inArray, lt, notLike, or, isNull, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { encryptSecret } from '../auth/secrets';
import { checkPluginUrl, PluginFetchError } from '../plugins/ssrf';
import { AGENT_USER_PREFIX, ACTIVE_STATUSES, SKIPPED_PREFIX, AGENT_TRIGGERS, type RunStatus, type RunTrigger, clampText } from './logic';
import { generateRunToken, hashRunToken, runTokenTtlMs } from './auth';

export type AgentRow = typeof schema.agents.$inferSelect;
export type RunRow = typeof schema.agentRuns.$inferSelect;

export class AgentError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export const newSigningSecret = () => 'whsec_' + randomBytes(32).toString('hex');

export function validateWebhookUrl(raw: string): string {
  try { return checkPluginUrl(raw).toString(); } catch (e) { throw new AgentError(400, e instanceof PluginFetchError ? e.message : 'Invalid webhook URL'); }
}

export function agentView(a: AgentRow, u: typeof schema.users.$inferSelect, owner?: { id: number; displayName: string } | null) {
  return {
    id: a.id, userId: a.userId, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, description: a.description,
    enabled: a.enabled, isAgent: true,
    owner: owner ? { id: owner.id, displayName: owner.displayName } : null,
    webhookUrl: a.webhookUrl, hasSigningSecret: !!a.signingSecretEnc, triggers: a.triggers,
    limits: { maxConcurrentRuns: a.maxConcurrentRuns, maxRunsPerIssue: a.maxRunsPerIssue, maxRunsPerHour: a.maxRunsPerHour },
    consecutiveFailures: a.consecutiveFailures, createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

export async function loadAgent(id: number): Promise<{ agent: AgentRow; user: typeof schema.users.$inferSelect }> {
  const [row] = await db.select({ agent: schema.agents, user: schema.users }).from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId)).where(eq(schema.agents.id, id)).limit(1);
  if (!row) throw new AgentError(404, 'Agent not found');
  return row;
}

export async function listAgents() {
  const rows = await db.select({ agent: schema.agents, user: schema.users }).from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId)).orderBy(schema.users.displayName);
  const ownerIds = [...new Set(rows.map((r) => r.agent.ownerId).filter((x): x is number => !!x))];
  const owners = ownerIds.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, ownerIds)) : [];
  const byId = new Map(owners.map((o) => [o.id, o]));
  return rows.map((r) => agentView(r.agent, r.user, r.agent.ownerId ? byId.get(r.agent.ownerId) : null));
}

export async function viewOf(id: number) {
  const { agent, user } = await loadAgent(id);
  const [owner] = agent.ownerId ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, agent.ownerId)).limit(1) : [];
  return agentView(agent, user, owner);
}

export interface CreateAgentInput {
  slug: string; displayName: string; description?: string | null; avatarUrl?: string | null; ownerId: number;
  webhookUrl?: string | null; triggers?: string[];
  limits?: { maxConcurrentRuns?: number; maxRunsPerIssue?: number; maxRunsPerHour?: number };
}

export async function createAgent(input: CreateAgentInput) {
  const username = AGENT_USER_PREFIX + input.slug;
  const [dup] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1);
  if (dup) throw new AgentError(409, 'An agent or user with this name already exists');
  const webhookUrl = input.webhookUrl ? validateWebhookUrl(input.webhookUrl) : null;
  const triggers = [...new Set(input.triggers ?? ['assigned', 'mentioned'])].filter((t) => (AGENT_TRIGGERS as readonly string[]).includes(t));
  const signingSecret = newSigningSecret();
  const created = await db.transaction(async (tx) => {
    // Service account: no password, never signs in. `active` stays true so it can be assigned, mentioned and use its tokens.
    const [u] = await tx.insert(schema.users).values({
      username, email: `${input.slug}@agents.invalid`, displayName: input.displayName, active: true, passwordHash: null, avatarUrl: input.avatarUrl ?? null,
    }).returning();
    const [a] = await tx.insert(schema.agents).values({
      userId: u.id, ownerId: input.ownerId, description: input.description ?? null, enabled: true, webhookUrl,
      signingSecretEnc: encryptSecret(signingSecret), triggers,
      ...(input.limits?.maxConcurrentRuns ? { maxConcurrentRuns: input.limits.maxConcurrentRuns } : {}),
      ...(input.limits?.maxRunsPerIssue ? { maxRunsPerIssue: input.limits.maxRunsPerIssue } : {}),
      ...(input.limits?.maxRunsPerHour ? { maxRunsPerHour: input.limits.maxRunsPerHour } : {}),
    }).returning();
    return { agent: a, user: u };
  });
  return { id: created.agent.id, signingSecret };
}

export interface UpdateAgentInput {
  displayName?: string; description?: string | null; avatarUrl?: string | null; ownerId?: number;
  webhookUrl?: string | null; triggers?: string[];
  limits?: { maxConcurrentRuns?: number; maxRunsPerIssue?: number; maxRunsPerHour?: number };
}

export async function updateAgent(id: number, input: UpdateAgentInput) {
  const { agent } = await loadAgent(id);
  const set: Partial<typeof schema.agents.$inferInsert> = { updatedAt: new Date() };
  if (input.description !== undefined) set.description = input.description;
  if (input.ownerId !== undefined) set.ownerId = input.ownerId;
  if (input.webhookUrl !== undefined) set.webhookUrl = input.webhookUrl ? validateWebhookUrl(input.webhookUrl) : null;
  if (input.triggers) set.triggers = [...new Set(input.triggers)].filter((t) => (AGENT_TRIGGERS as readonly string[]).includes(t));
  if (input.limits?.maxConcurrentRuns) set.maxConcurrentRuns = input.limits.maxConcurrentRuns;
  if (input.limits?.maxRunsPerIssue) set.maxRunsPerIssue = input.limits.maxRunsPerIssue;
  if (input.limits?.maxRunsPerHour) set.maxRunsPerHour = input.limits.maxRunsPerHour;
  if (input.webhookUrl !== undefined && input.webhookUrl !== agent.webhookUrl) set.consecutiveFailures = 0;
  await db.update(schema.agents).set(set).where(eq(schema.agents.id, id));
  if (input.displayName !== undefined || input.avatarUrl !== undefined) {
    await db.update(schema.users).set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.users.id, agent.userId));
  }
}

/** Revoke every run token of the agent (used on disable and delete). Active runs are cancelled. */
export async function cancelActiveRuns(agentId: number, reason: string) {
  await db.update(schema.agentRuns).set({ status: 'cancelled', tokenHash: null, error: reason, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.agentRuns.agentId, agentId), inArray(schema.agentRuns.status, [...ACTIVE_STATUSES])));
}

export async function setEnabled(id: number, enabled: boolean) {
  const { agent } = await loadAgent(id);
  await db.update(schema.agents).set({ enabled, consecutiveFailures: enabled ? 0 : agent.consecutiveFailures, updatedAt: new Date() }).where(eq(schema.agents.id, id));
  await db.update(schema.users).set({ active: enabled, updatedAt: new Date() }).where(eq(schema.users.id, agent.userId));
  if (!enabled) await cancelActiveRuns(id, 'Agent disabled');
}

export async function rotateSigningSecret(id: number) {
  await loadAgent(id);
  const secret = newSigningSecret();
  await db.update(schema.agents).set({ signingSecretEnc: encryptSecret(secret), updatedAt: new Date() }).where(eq(schema.agents.id, id));
  return secret;
}

/**
 * Delete an agent. Its user row is kept (issues it reported, comments and history reference it) but deactivated, renamed so the
 * name can be reused, stripped of group memberships and role assignments; tokens are revoked and the run log is deleted.
 */
export async function deleteAgent(id: number) {
  const { agent, user } = await loadAgent(id);
  await db.transaction(async (tx) => {
    await tx.update(schema.personalAccessTokens).set({ revokedAt: new Date() }).where(and(eq(schema.personalAccessTokens.userId, user.id), isNull(schema.personalAccessTokens.revokedAt)));
    await tx.delete(schema.userGroups).where(eq(schema.userGroups.userId, user.id));
    await tx.delete(schema.projectRoleActors).where(eq(schema.projectRoleActors.userId, user.id));
    await tx.delete(schema.permissionEntries).where(eq(schema.permissionEntries.userId, user.id));
    await tx.update(schema.issues).set({ assigneeId: null }).where(eq(schema.issues.assigneeId, user.id));
    await tx.delete(schema.agents).where(eq(schema.agents.id, agent.id)); // runs cascade
    await tx.update(schema.users).set({
      active: false, username: `deleted-agent-${user.id}`, email: `deleted-agent-${user.id}@agents.invalid`, displayName: `${user.displayName} (deleted agent)`.slice(0, 255), updatedAt: new Date(),
    }).where(eq(schema.users.id, user.id));
  });
}

/* ---------------------------- long-lived tokens ---------------------------- */

export async function listAgentTokens(agentUserId: number) {
  return db.select({
    id: schema.personalAccessTokens.id, name: schema.personalAccessTokens.name, scopes: schema.personalAccessTokens.scopes,
    createdAt: schema.personalAccessTokens.createdAt, lastUsedAt: schema.personalAccessTokens.lastUsedAt, expiresAt: schema.personalAccessTokens.expiresAt,
  }).from(schema.personalAccessTokens).where(and(eq(schema.personalAccessTokens.userId, agentUserId), isNull(schema.personalAccessTokens.revokedAt)));
}

/* ---------------------------------- runs ---------------------------------- */

const staleMs = () => {
  const n = Number(process.env.AGENT_RUN_TIMEOUT_MINUTES);
  return (Number.isFinite(n) && n >= 1 ? n : 60) * 60_000;
};

/** Runs that never reported back would block the concurrency limits forever: fail them after the timeout (default 60 min). */
export async function expireStaleRuns() {
  await db.update(schema.agentRuns).set({ status: 'failed', error: 'Timed out without a final report', tokenHash: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]), lt(schema.agentRuns.updatedAt, new Date(Date.now() - staleMs()))));
}

export async function runCounts(agentId: number, issueId: number) {
  const active = [...ACTIVE_STATUSES];
  const [row] = await db.select({
    activeForAgent: sql<number>`count(*) filter (where ${schema.agentRuns.status} in ('queued','delivered','running'))::int`,
    activeForIssue: sql<number>`count(*) filter (where ${schema.agentRuns.status} in ('queued','delivered','running') and ${schema.agentRuns.issueId} = ${issueId})::int`,
    startedLastHour: sql<number>`count(*) filter (where ${schema.agentRuns.createdAt} > now() - interval '1 hour' and (${schema.agentRuns.error} is null or ${schema.agentRuns.error} not like ${SKIPPED_PREFIX + '%'}))::int`,
  }).from(schema.agentRuns).where(and(eq(schema.agentRuns.agentId, agentId), or(inArray(schema.agentRuns.status, active), gt(schema.agentRuns.createdAt, new Date(Date.now() - 3600_000)))));
  return row ?? { activeForAgent: 0, activeForIssue: 0, startedLastHour: 0 };
}

export function runView(r: RunRow, extra: Record<string, unknown> = {}) {
  return {
    id: r.id, agentId: r.agentId, issueId: r.issueId, projectId: r.projectId, trigger: r.trigger, status: r.status as RunStatus,
    chainDepth: r.chainDepth, attempts: r.attempts, error: r.error, summary: r.summary, resultUrl: r.resultUrl,
    createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, updatedAt: r.updatedAt,
    ...extra,
  };
}

/** Give a run a fresh short-lived token. Returns the plain token (shown once). */
export async function mintRunToken(runId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = generateRunToken();
  const expiresAt = new Date(Date.now() + runTokenTtlMs());
  await db.update(schema.agentRuns).set({ tokenHash: hashRunToken(token), tokenExpiresAt: expiresAt, updatedAt: new Date() }).where(eq(schema.agentRuns.id, runId));
  return { token, expiresAt };
}

export async function revokeRunToken(runId: number) {
  await db.update(schema.agentRuns).set({ tokenHash: null, tokenExpiresAt: null }).where(eq(schema.agentRuns.id, runId));
}

export async function insertRun(v: { agentId: number; issueId: number; projectId: number; trigger: RunTrigger; triggeredBy: number | null; chainDepth: number; skipped?: string; status?: RunStatus }) {
  const now = new Date();
  const [row] = await db.insert(schema.agentRuns).values({
    agentId: v.agentId, issueId: v.issueId, projectId: v.projectId, trigger: v.trigger, triggeredBy: v.triggeredBy, chainDepth: v.chainDepth,
    status: v.skipped ? 'cancelled' : (v.status ?? 'queued'), error: v.skipped ? clampText(SKIPPED_PREFIX + v.skipped, 500) : null,
    finishedAt: v.skipped ? now : null,
  }).returning();
  return row;
}

export async function runsForIssue(issueId: number, limit = 50) {
  const rows = await db.select({ run: schema.agentRuns, agentName: schema.users.displayName, agentUsername: schema.users.username })
    .from(schema.agentRuns).innerJoin(schema.agents, eq(schema.agents.id, schema.agentRuns.agentId))
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId))
    .where(eq(schema.agentRuns.issueId, issueId)).orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id)).limit(limit);
  return rows.map((r) => runView(r.run, { agent: { id: r.run.agentId, displayName: r.agentName, username: r.agentUsername } }));
}

export async function recentRuns(opts: { agentId?: number; projectIds?: number[]; status?: string; limit?: number }) {
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.agentId) conds.push(eq(schema.agentRuns.agentId, opts.agentId));
  if (opts.projectIds) conds.push(inArray(schema.agentRuns.projectId, opts.projectIds.length ? opts.projectIds : [-1]));
  if (opts.status) conds.push(eq(schema.agentRuns.status, opts.status));
  const rows = await db.select({ run: schema.agentRuns, agentName: schema.users.displayName, agentUsername: schema.users.username, issueKey: schema.issues.issueKey })
    .from(schema.agentRuns).innerJoin(schema.agents, eq(schema.agents.id, schema.agentRuns.agentId))
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId))
    .innerJoin(schema.issues, eq(schema.issues.id, schema.agentRuns.issueId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id)).limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map((r) => runView(r.run, { issueKey: r.issueKey, agent: { id: r.run.agentId, displayName: r.agentName, username: r.agentUsername } }));
}

