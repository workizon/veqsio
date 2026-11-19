/**
 * Pure decision logic for AI agents: which event starts a run, who is mentioned, and the loop/rate guards.
 * No database access here so it can be unit tested exhaustively (agents/logic.test.ts).
 */

export const AGENT_USER_PREFIX = 'agent:';
export const AGENT_TRIGGERS = ['assigned', 'mentioned', 'status_changed', 'commented'] as const;
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number];
export type RunTrigger = AgentTrigger | 'claim';
export const RUN_STATUSES = ['queued', 'delivered', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'delivered', 'running'];
export const TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Marks runs that were not started because a guard refused them (kept in the log, not counted against the hourly limit). */
export const SKIPPED_PREFIX = 'Skipped: ';

export const isAgentUsername = (username: string | null | undefined) => !!username && username.startsWith(AGENT_USER_PREFIX);
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** `@agent:slug` mentions (what the editor inserts for an agent user). Returns lower-case usernames, deduplicated. */
export function extractAgentMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /(^|[^A-Za-z0-9_@:.\/-])@(agent:[A-Za-z0-9][A-Za-z0-9_-]{1,63})(?![A-Za-z0-9_-])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[2].toLowerCase());
  return [...out];
}

/** Mentions present in `next` that were not already in `prev` (editing a description must not re-trigger old mentions). */
export function newAgentMentions(prev: string | null | undefined, next: string | null | undefined): string[] {
  const before = new Set(extractAgentMentions(prev));
  return extractAgentMentions(next).filter((m) => !before.has(m));
}

export interface AgentLite { id: number; userId: number; username: string; enabled: boolean; triggers: string[] }

export interface EventFacts {
  /** user whose action caused the event */
  actorUserId: number;
  /** current assignee of the issue (after the event) */
  assigneeUserId: number | null;
  assigneeChanged: boolean;
  statusChanged: boolean;
  commented: boolean;
  /** lower-case agent usernames mentioned in newly written text (comment, new description) */
  mentioned: string[];
}

/**
 * Which trigger (if any) starts a run for this agent. First match wins: assigned, mentioned, status_changed, commented.
 * An agent is never triggered by its own actions (loop protection #1).
 */
export function matchTrigger(agent: AgentLite, ev: EventFacts): AgentTrigger | null {
  if (!agent.enabled) return null;
  if (ev.actorUserId === agent.userId) return null;
  const has = (t: AgentTrigger) => agent.triggers.includes(t);
  const isAssignee = ev.assigneeUserId === agent.userId;
  if (has('assigned') && ev.assigneeChanged && isAssignee) return 'assigned';
  if (has('mentioned') && ev.mentioned.includes(agent.username.toLowerCase())) return 'mentioned';
  if (has('status_changed') && ev.statusChanged && isAssignee) return 'status_changed';
  if (has('commented') && ev.commented && isAssignee) return 'commented';
  return null;
}

export const DEFAULT_MAX_CHAIN_DEPTH = 3;

/**
 * Chain depth of a run caused by `actor`. A human action starts a chain at 0. If the actor is itself an agent the new run
 * is one level deeper than the actor's own run (1 when the actor acts without a run, e.g. through its long-lived token).
 */
export function nextChainDepth(actorIsAgent: boolean, actorRunDepth: number | null): number {
  if (!actorIsAgent) return 0;
  return (actorRunDepth ?? 0) + 1;
}

export interface LimitInput {
  chainDepth: number;
  maxChainDepth: number;
  activeForAgent: number;
  activeForIssue: number;
  startedLastHour: number;
  maxConcurrentRuns: number;
  maxRunsPerIssue: number;
  maxRunsPerHour: number;
}

/** null = allowed, otherwise the human readable reason (without the "Skipped: " prefix). */
export function limitViolation(l: LimitInput): string | null {
  if (l.chainDepth > l.maxChainDepth) return `agent chain depth ${l.chainDepth} exceeds the maximum of ${l.maxChainDepth}`;
  if (l.activeForIssue >= l.maxRunsPerIssue) return `the agent already has ${l.activeForIssue} active run(s) on this issue (limit ${l.maxRunsPerIssue})`;
  if (l.activeForAgent >= l.maxConcurrentRuns) return `the agent already has ${l.activeForAgent} active run(s) (limit ${l.maxConcurrentRuns})`;
  if (l.startedLastHour >= l.maxRunsPerHour) return `the agent reached its limit of ${l.maxRunsPerHour} runs per hour`;
  return null;
}

/** Allowed status transitions reported by the agent. */
export function canReport(status: RunStatus, action: 'started' | 'progress' | 'finished'): boolean {
  if (TERMINAL_STATUSES.includes(status)) return false;
  if (action === 'started') return status === 'queued' || status === 'delivered' || status === 'running';
  return true;
}

export function clampText(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function isHttpUrl(raw: string): boolean {
  try { const u = new URL(raw); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch { return false; }
}
