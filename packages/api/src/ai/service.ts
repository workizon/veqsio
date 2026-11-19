/**
 * AI features. Every function re-checks BROWSE_PROJECTS on the issue's project and only feeds the model data
 * the caller may see. The model never gets tools; its output is validated before it is returned.
 * Nothing here applies a change to any issue.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { checkProjectPermission } from '../middleware/permissions';
import { getBrowsableProjectIds } from '../services/browse';
import { issueDeskAccess } from '../servicedesk/service';
import { acquireSlot, AiLimitError, recordTokens, refundUsage, reserveDailyUsage } from './limits';
import { isConfigured, loadSettings, resolveProvider, type AiSettings, type FeatureKey } from './config';
import { AiProviderError } from './provider';
import {
  buildReleaseNotesPrompt, buildRerankPrompt, buildReviewPrompt, buildSuggestPrompt, buildSummarizePrompt,
  parseRerank, sanitizeOutput, validateSuggestion, type BuiltPrompt, type NamedId, type Suggestion,
} from './prompts';
import { issueVisibleSql } from '../security/issue-security';
import { buildRulePrompt, parseRuleDraft, type RuleDraft } from './rules';
import { checkJql } from '../dashboards/gadget-query';
import { findSimilarIssues, type SimilarIssue } from './similar';

type User = typeof schema.users.$inferSelect;

export class AiHttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 429 | 502 | 503, message: string, readonly retryAfter?: number) {
    super(message);
    this.name = 'AiHttpError';
  }
}

const notFound = () => new AiHttpError(404, 'Not found');

async function llmSettings(feature: FeatureKey): Promise<AiSettings> {
  const s = await loadSettings();
  if (!isConfigured(s)) throw new AiHttpError(503, 'AI is not configured');
  if (!s.features[feature]) throw new AiHttpError(503, 'AI feature is disabled');
  return s;
}

/** Quota + concurrency + provider call. Provider failures refund the quota and surface a generic 502. */
async function runLlm(user: User, feature: FeatureKey, s: AiSettings, prompt: BuiltPrompt): Promise<string> {
  let release: (() => Promise<void>) | null = null;
  let usageId: number | null = null;
  try {
    release = await acquireSlot();
    usageId = await reserveDailyUsage(user.id, feature, s.dailyRequestLimitPerUser);
    const provider = resolveProvider(s);
    const res = await provider.complete({ system: prompt.system, messages: prompt.messages, maxTokens: prompt.maxTokens, signal: AbortSignal.timeout(65_000) });
    await recordTokens(usageId, res.tokensIn, res.tokensOut).catch(() => {});
    return res.text;
  } catch (err) {
    if (err instanceof AiLimitError) throw new AiHttpError(err.status, err.message, err.retryAfter);
    if (usageId !== null) await refundUsage(usageId).catch(() => {});
    if (err instanceof AiProviderError) throw new AiHttpError(502, err.message);
    // Do not echo arbitrary errors (could contain config details); log only the error name.
    console.error('[ai] unexpected failure:', (err as Error)?.name);
    throw new AiHttpError(502, 'AI request failed');
  } finally {
    if (release) await release();
  }
}

async function loadIssueForCaller(user: User, key: string) {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, key)).limit(1);
  if (!issue || !(await checkProjectPermission(user, issue.projectId, 'BROWSE_PROJECTS'))) throw notFound();
  return issue;
}

/* -------------------------------- Similar issues -------------------------------- */

export async function similarForIssue(user: User, key: string): Promise<{ issues: SimilarIssue[]; reranked: boolean }> {
  const s = await loadSettings();
  if (!s.features.similar) throw new AiHttpError(503, 'AI feature is disabled');
  const issue = await loadIssueForCaller(user, key);
  const browsable = await getBrowsableProjectIds(user);
  const found = await findSimilarIssues({ summary: issue.summary, description: issue.description, browsableProjectIds: browsable, viewerId: user.id, excludeIssueId: issue.id, limit: 5 });
  return maybeRerank(user, s, { summary: issue.summary, description: issue.description }, found);
}

export async function similarForDraft(user: User, input: { projectId: number; summary: string; description?: string | null }) {
  const s = await loadSettings();
  if (!s.features.similar) throw new AiHttpError(503, 'AI feature is disabled');
  if (!(await checkProjectPermission(user, input.projectId, 'BROWSE_PROJECTS'))) throw notFound();
  const browsable = await getBrowsableProjectIds(user);
  const found = await findSimilarIssues({ summary: input.summary, description: input.description, browsableProjectIds: browsable, viewerId: user.id, limit: 5 });
  // Typing-time hint: never spends LLM quota, only the full-text path.
  return { issues: found, reranked: false };
}

async function maybeRerank(user: User, s: AiSettings, subject: { summary: string; description: string | null }, found: SimilarIssue[]) {
  if (found.length < 2 || !isConfigured(s)) return { issues: found, reranked: false };
  try {
    const text = await runLlm(user, 'similar', s, buildRerankPrompt(subject, found, s.maxInputChars));
    const order = parseRerank(text, found.map((f) => f.key));
    if (!order || order.length === 0) return { issues: found, reranked: false };
    const byKey = new Map(found.map((f) => [f.key, f]));
    // Re-rank only reorders and may drop; it can never add an issue the full-text search did not return.
    return { issues: order.map((k) => byKey.get(k)!), reranked: true };
  } catch {
    return { issues: found, reranked: false }; // the no-LLM result is always a valid answer
  }
}

/* ---------------------------------- Summarize ---------------------------------- */

export async function summarizeIssue(user: User, key: string): Promise<{ summary: string; containsInternal: boolean; truncated: boolean; generatedAt: string }> {
  const s = await llmSettings('summarize');
  const issue = await loadIssueForCaller(user, key);
  const access = await issueDeskAccess(user, issue.id);
  // Customers of a service request never get AI endpoints.
  if (access.isRequest && !access.staff && access.customerId === user.id) throw notFound();

  const rows = await db.select({
    body: schema.comments.body, createdAt: schema.comments.createdAt, internal: schema.comments.isInternal,
    author: schema.users.displayName,
  }).from(schema.comments)
    .leftJoin(schema.users, eq(schema.users.id, schema.comments.authorId))
    .where(access.staff
      ? eq(schema.comments.issueId, issue.id)
      : and(eq(schema.comments.issueId, issue.id), eq(schema.comments.isInternal, false)))
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
    .limit(1000);

  const prompt = buildSummarizePrompt({
    key: issue.issueKey, summary: issue.summary, description: issue.description,
    comments: rows.map((r) => ({ author: r.author ?? 'Unknown', createdAt: r.createdAt, body: r.body, internal: !!r.internal })),
  }, s.maxInputChars);
  const containsInternal = access.staff && rows.some((r) => !!r.internal) // conservative: flagged even if truncation dropped the note;

  const text = await runLlm(user, 'summarize', s, prompt);
  return { summary: sanitizeOutput(text, 4000), containsInternal, truncated: prompt.truncated, generatedAt: new Date().toISOString() };
}

/* ------------------------- Post-incident review draft ------------------------- */

/**
 * A draft of a blameless post-incident review from the issue and its comments. Same rules as the summary: the caller
 * must be able to browse the issue, customers of a request never get it, internal notes only reach the model for desk
 * staff and the result is flagged when it may contain them. The draft is text for a person to edit; nothing is saved.
 */
export async function draftPostIncidentReview(user: User, key: string): Promise<{ review: string; containsInternal: boolean; truncated: boolean; generatedAt: string }> {
  const s = await llmSettings('review');
  const issue = await loadIssueForCaller(user, key);
  const access = await issueDeskAccess(user, issue.id);
  if (access.isRequest && !access.staff && access.customerId === user.id) throw notFound();

  const rows = await db.select({
    body: schema.comments.body, createdAt: schema.comments.createdAt, internal: schema.comments.isInternal, author: schema.users.displayName,
  }).from(schema.comments)
    .leftJoin(schema.users, eq(schema.users.id, schema.comments.authorId))
    .where(access.staff ? eq(schema.comments.issueId, issue.id) : and(eq(schema.comments.issueId, issue.id), eq(schema.comments.isInternal, false)))
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
    .limit(1000);

  const prompt = buildReviewPrompt({
    key: issue.issueKey, summary: issue.summary, description: issue.description,
    comments: rows.map((r) => ({ author: r.author ?? 'Unknown', createdAt: r.createdAt, body: r.body, internal: !!r.internal })),
  }, s.maxInputChars);
  const containsInternal = access.staff && rows.some((r) => !!r.internal);
  const text = await runLlm(user, 'review', s, prompt);
  return { review: sanitizeOutput(text, 8000), containsInternal, truncated: prompt.truncated, generatedAt: new Date().toISOString() };
}

/* ------------------------- Automation rule draft ------------------------- */

/**
 * Turns a sentence into a DRAFT automation rule built from a closed vocabulary (see ai/rules.ts). Nothing is saved or
 * enabled; the caller reviews the draft and creates the rule through the normal rule API. The model only sees the
 * description and the names of global priorities, issue types and statuses.
 */
export async function draftAutomationRule(user: User, description: string): Promise<{ draft: RuleDraft; warnings: string[]; generatedAt: string }> {
  const s = await llmSettings('rule_draft');
  const [priorities, issueTypes, statuses, users] = await Promise.all([
    db.select({ id: schema.priorities.id, name: schema.priorities.name }).from(schema.priorities),
    db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name }).from(schema.issueTypes),
    db.select({ id: schema.statuses.id, name: schema.statuses.name }).from(schema.statuses),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(eq(schema.users.active, true)).limit(500),
  ]);
  const vocab = { priorities, issueTypes, statuses, users: users.filter((u) => !u.username.startsWith('agent:')) };
  const text = await runLlm(user, 'rule_draft', s, buildRulePrompt(description, vocab, s.maxInputChars));
  // JQL is validated against the engine, so a hallucinated field never reaches a rule
  const bad = new Map<string, string | null>();
  for (const m of text.matchAll(/"value"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const v = m[1].replace(/\\"/g, '"');
    if (!bad.has(v)) bad.set(v, await checkJql(v));
  }
  const parsed = parseRuleDraft(text, vocab, (jql) => bad.get(jql) ?? null);
  if (!parsed.ok) throw new AiHttpError(502, parsed.error);
  return { draft: parsed.draft, warnings: parsed.warnings, generatedAt: new Date().toISOString() };
}

/* ------------------------------ Classify / triage ------------------------------ */

export async function projectTriageOptions(projectId: number): Promise<{ types: NamedId[]; priorities: NamedId[]; labels: string[] }> {
  const [assoc] = await db.select().from(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, projectId)).limit(1);
  const allTypes = await db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name, isSubtask: schema.issueTypes.isSubtask }).from(schema.issueTypes);
  let allowedIds: Set<number> | null = null;
  if (assoc) {
    const items = await db.select({ id: schema.issueTypeSchemeItems.issueTypeId }).from(schema.issueTypeSchemeItems).where(eq(schema.issueTypeSchemeItems.schemeId, assoc.schemeId));
    allowedIds = new Set(items.map((i) => i.id));
  }
  const types = allTypes.filter((t) => !t.isSubtask && (!allowedIds || allowedIds.has(t.id))).map((t) => ({ id: t.id, name: t.name }));
  const priorities = (await db.select({ id: schema.priorities.id, name: schema.priorities.name }).from(schema.priorities).orderBy(asc(schema.priorities.sortOrder), asc(schema.priorities.id)));
  // Labels already used in THIS project: never reveals labels that exist only in projects the caller cannot see.
  const labelRows = await db.select({ name: schema.labels.name, n: sql<number>`count(*)::int` })
    .from(schema.issueLabels)
    .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
    .innerJoin(schema.issues, eq(schema.issues.id, schema.issueLabels.issueId))
    .where(and(eq(schema.issues.projectId, projectId), issueVisibleSql(null)))
    .groupBy(schema.labels.name).orderBy(desc(sql`count(*)`)).limit(200);
  return { types, priorities, labels: labelRows.map((l) => l.name) };
}

export async function suggestTriage(user: User, input: { projectId: number; summary: string; description?: string | null }): Promise<Suggestion & { applied: false }> {
  const s = await llmSettings('classify');
  if (!(await checkProjectPermission(user, input.projectId, 'BROWSE_PROJECTS'))) throw notFound();
  const opts = await projectTriageOptions(input.projectId);
  const prompt = buildSuggestPrompt({ summary: input.summary, description: input.description ?? null }, opts.types, opts.priorities, opts.labels, s.maxInputChars);
  const text = await runLlm(user, 'classify', s, prompt);
  return { ...validateSuggestion(text, opts.types, opts.priorities, opts.labels), applied: false };
}

/* ------------------------------- Release notes ------------------------------- */

export async function draftReleaseNotes(user: User, projectKey: string, versionId: number): Promise<{ notes: string; issueCount: number; truncated: boolean; generatedAt: string }> {
  const s = await llmSettings('release_notes');
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
  if (!project || !(await checkProjectPermission(user, project.id, 'BROWSE_PROJECTS'))) throw notFound();
  // The permission model has no dedicated release permission; version management is a project-admin task.
  const mayRelease = (await checkProjectPermission(user, project.id, 'PROJECT_ADMIN')) || (await checkProjectPermission(user, project.id, 'ADMINISTER_PROJECTS'));
  if (!mayRelease) throw new AiHttpError(403, 'Forbidden');
  const [version] = await db.select().from(schema.versions).where(and(eq(schema.versions.id, versionId), eq(schema.versions.projectId, project.id))).limit(1);
  if (!version) throw notFound();

  const rows = await db.select({ key: schema.issues.issueKey, summary: schema.issues.summary, type: schema.issueTypes.name })
    .from(schema.issueFixVersions)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.issueFixVersions.issueId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .where(and(eq(schema.issueFixVersions.versionId, version.id), eq(schema.issues.projectId, project.id), issueVisibleSql(user.id)))
    .orderBy(asc(schema.issues.id)).limit(500);
  if (rows.length === 0) throw new AiHttpError(400, 'This version has no issues');

  const prompt = buildReleaseNotesPrompt({ name: version.name, description: version.description }, rows, s.maxInputChars);
  const text = await runLlm(user, 'release_notes', s, prompt);
  return { notes: sanitizeOutput(text, 8000), issueCount: rows.length, truncated: prompt.truncated, generatedAt: new Date().toISOString() };
}

/** Admin "test connection": a tiny fixed prompt, no user content, counted against nobody's quota. */
export async function testConnection(s: AiSettings): Promise<{ ok: boolean; message: string }> {
  if (!s.model) return { ok: false, message: 'Select a model first' };
  try {
    const release = await acquireSlot();
    try {
      const res = await resolveProvider(s).complete({
        system: 'You are a connectivity check. Reply with the single word OK.',
        messages: [{ role: 'user', content: 'ping' }], maxTokens: 8, signal: AbortSignal.timeout(65_000),
      });
      return { ok: res.text.trim().length > 0, message: res.text.trim().length > 0 ? 'Connection works' : 'Provider returned an empty answer' };
    } finally { await release(); }
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AiLimitError) return { ok: false, message: err.message };
    return { ok: false, message: 'Connection failed' };
  }
}
