/**
 * Credentials of AI agents.
 *
 *  - Long-lived: ordinary personal access tokens (`veqsio_...`) owned by the agent's user, with scopes. The generic
 *    PAT path in the session middleware applies, plus the check below that the agent is still enabled.
 *  - Short-lived run tokens (`vqr_...`): minted per run, 30 minutes by default, stored only as a SHA-256 hash on the run
 *    row, dead as soon as the run ends or is stopped. They authenticate as the agent's user but may only touch the
 *    run's issue and project (see runTokenAllows); the agent's normal permissions still apply on top.
 */
import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { ACTIVE_STATUSES } from './logic';

export const RUN_TOKEN_PREFIX = 'vqr_';
export const hashRunToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const generateRunToken = () => RUN_TOKEN_PREFIX + randomBytes(32).toString('hex');

export function runTokenTtlMs(): number {
  const n = Number(process.env.AGENT_RUN_TOKEN_TTL_MINUTES);
  return (Number.isFinite(n) && n >= 1 && n <= 24 * 60 ? n : 30) * 60_000;
}

export interface RunPrincipal {
  user: typeof schema.users.$inferSelect;
  run: { id: number; agentId: number; issueId: number; projectId: number };
}

export async function getAgentByUserId(userId: number) {
  const [a] = await db.select().from(schema.agents).where(eq(schema.agents.userId, userId)).limit(1);
  return a ?? null;
}

/** Resolves a run token. Null for unknown, expired, revoked tokens, finished runs and disabled agents. */
export async function resolveRunPrincipal(token: string): Promise<RunPrincipal | null> {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) return null;
  const [row] = await db.select().from(schema.agentRuns)
    .where(and(
      eq(schema.agentRuns.tokenHash, hashRunToken(token)),
      isNotNull(schema.agentRuns.tokenHash),
      gt(schema.agentRuns.tokenExpiresAt, new Date()),
      inArray(schema.agentRuns.status, [...ACTIVE_STATUSES]),
    )).limit(1);
  if (!row) return null;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, row.agentId)).limit(1);
  if (!agent || !agent.enabled) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, agent.userId)).limit(1);
  if (!user || user.active === false) return null;
  return { user, run: { id: row.id, agentId: row.agentId, issueId: row.issueId, projectId: row.projectId } };
}

async function projectOfIssueRef(ref: string): Promise<{ id: number; projectId: number } | null> {
  const isNum = /^\d{1,9}$/.test(ref);
  const [r] = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues)
    .where(isNum ? eq(schema.issues.id, Number(ref)) : eq(schema.issues.issueKey, ref.toUpperCase())).limit(1);
  return r ?? null;
}

/**
 * Route allow-list for run tokens (deny by default): read the issues and the project of the run, comment on and transition the
 * run's own issue, and report on the run. Everything else (other projects, edits, search, admin, other runs) is refused.
 */
export async function runTokenAllows(run: RunPrincipal['run'], method: string, rawPath: string): Promise<boolean> {
  const path = rawPath.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const m = method.toUpperCase();
  const read = m === 'GET' || m === 'HEAD';

  if (read && /^\/rest\/api\/2\/(myself|serverinfo)$/i.test(path)) return true;

  const runPath = /^\/rest\/api\/2\/agent-runs\/(\d{1,9})(?:\/(started|progress|finished|token))?$/i.exec(path);
  if (runPath) {
    if (Number(runPath[1]) !== run.id) return false;
    return runPath[2] ? m === 'POST' : read;
  }

  const issuePath = /^\/rest\/api\/2\/issue\/([^/]+)(\/.*)?$/i.exec(path);
  if (issuePath) {
    let ref: string;
    try { ref = decodeURIComponent(issuePath[1]); } catch { return false; }
    const rest = (issuePath[2] ?? '').toLowerCase();
    const issue = await projectOfIssueRef(ref);
    if (!issue || issue.projectId !== run.projectId) return false;
    if (read) return true;
    if (m === 'POST' && issue.id === run.issueId && (rest === '/comment' || rest === '/transitions')) return true;
    return false;
  }

  const projectPath = /^\/rest\/api\/2\/project\/([^/]+)$/i.exec(path);
  if (projectPath && read) {
    const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, decodeURIComponent(projectPath[1]).toUpperCase())).limit(1);
    return !!p && p.id === run.projectId;
  }
  return false;
}
