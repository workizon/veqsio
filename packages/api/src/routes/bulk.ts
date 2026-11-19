/**
 * Bulk issue operations.
 *
 *   POST /rest/api/2/bulk/issues[?preview=true]            { issueKeys: [...<=500], operation, params }
 *   POST /rest/api/2/bulk/issues/transitions               { issueKeys }   -> transitions available per issue
 *
 * Execution does NOT reimplement anything: for every issue the matching single-issue endpoint is called in-process
 * (same Hono app, same credentials), so permission checks, workflow conditions / validators / post-functions,
 * history, notifications, automation and webhooks are exactly those of one request. One failing issue never aborts
 * the batch: the answer lists `succeeded` keys and `failed` ({ key, reason }). `?preview=true` changes nothing and
 * reports what would fail (missing permission, transition not available, sprint of another project, ...).
 */
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { and, eq, inArray } from 'drizzle-orm';
import { issueVisibleSql } from '../security/issue-security';
import { buildIssueResponses } from '../issues/service';
import { checkProjectPermission } from '../middleware/permissions';
import { getAvailableTransitions } from '../workflow/engine';
import { internalHeaders } from '../middleware/internal-request';
import {
  BULK_OPERATIONS, UNDOABLE, applyListChange, groupFailures, groupUndo, mergeTransitions, normalizeIssueKeys, parseBulkParams,
  reasonFromBody, sameList, type BulkFailure, type BulkOperation, type BulkParams, type UndoGroup,
} from '../bulk/helpers';

const app = new Hono<AppContext>();

const CONCURRENCY = 4;
const NOT_VISIBLE = 'Issue does not exist or you do not have permission to see it.';

type IssueRow = { id: number; key: string; projectId: number };
type Snapshot = Awaited<ReturnType<typeof buildIssueResponses>>[number];
interface Call { method: 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }

/** Permission the single-issue endpoint for each operation demands (on the issue's project). */
const PERMISSION: Record<BulkOperation, string> = {
  transition: 'TRANSITION_ISSUES', edit: 'EDIT_ISSUES', move: 'EDIT_ISSUES', delete: 'DELETE_ISSUES', watch: 'BROWSE_PROJECTS', unwatch: 'BROWSE_PROJECTS',
  label: 'EDIT_ISSUES', assign: 'EDIT_ISSUES', priority: 'EDIT_ISSUES', sprint: 'MANAGE_SPRINTS', fixVersion: 'EDIT_ISSUES', component: 'EDIT_ISSUES',
};
const NEEDS_SNAPSHOT = new Set<BulkOperation>(['edit', 'assign', 'priority', 'label', 'fixVersion', 'component']);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Issues hidden from `userId` by their security level resolve as missing ("not found"). */
async function resolveIssues(keys: string[], userId: number): Promise<Map<string, IssueRow>> {
  const rows = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, projectId: schema.issues.projectId })
    .from(schema.issues).where(and(inArray(schema.issues.issueKey, keys), issueVisibleSql(userId)));
  return new Map(rows.map((r) => [r.key.toUpperCase(), r]));
}

/** Memoised per-request project permission lookups. */
function permissionChecker(user: typeof schema.users.$inferSelect) {
  const memo = new Map<string, Promise<boolean>>();
  return (projectId: number, permission: string) => {
    const k = `${projectId}:${permission}`;
    if (!memo.has(k)) memo.set(k, checkProjectPermission(user, projectId, permission));
    return memo.get(k)!;
  };
}

/** The single-issue request that performs `op` on one issue. null = nothing to do (already in the wanted state). */
function callFor(op: BulkOperation, p: BulkParams, key: string, snap: Snapshot | undefined): Call | null {
  const base = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  switch (op) {
    case 'transition':
      return { method: 'POST', path: `${base}/transitions`, body: { transition: { id: p.transitionId }, fields: p.fields, ...(p.comment ? { comment: p.comment } : {}) } };
    case 'edit': return { method: 'PUT', path: base, body: { fields: p.fields } };
    case 'assign': return { method: 'PUT', path: base, body: { fields: { assignee: p.assigneeId === null ? null : { id: p.assigneeId } } } };
    case 'priority': return { method: 'PUT', path: base, body: { fields: { priority: { id: p.priorityId } } } };
    case 'label': {
      const cur = snap?.fields.labels ?? [];
      const next = applyListChange(cur, p);
      return sameList(cur, next) ? null : { method: 'PUT', path: base, body: { fields: { labels: next } } };
    }
    case 'fixVersion': {
      const cur = (snap?.fields.fixVersions ?? []).map((v: any) => v.id as number);
      const next = applyListChange(cur, p);
      return sameList(cur, next) ? null : { method: 'PUT', path: base, body: { fields: { fixVersions: next.map((id) => ({ id })) } } };
    }
    case 'component': {
      const cur = (snap?.fields.components ?? []).map((v: any) => v.id as number);
      const next = applyListChange(cur, p);
      return sameList(cur, next) ? null : { method: 'PUT', path: base, body: { fields: { components: next.map((id) => ({ id })) } } };
    }
    case 'move': return { method: 'POST', path: `${base}/move`, body: { projectId: p.projectId, ...(p.issueTypeId ? { issueTypeId: p.issueTypeId } : {}), ...(p.statusId ? { statusId: p.statusId } : {}) } };
    case 'delete': return { method: 'DELETE', path: base };
    case 'watch': return { method: 'POST', path: `${base}/watchers` };
    case 'unwatch': return { method: 'DELETE', path: `${base}/watchers` };
    case 'sprint':
      return p.sprintId === null
        ? { method: 'POST', path: '/rest/agile/1.0/backlog/issue', body: { issues: [key] } }
        : { method: 'POST', path: `/rest/agile/1.0/sprint/${p.sprintId}/issue`, body: { issues: [key] } };
  }
}

/** What to send to restore this issue's current state (only for undoable operations). null = not restorable. */
function undoParams(op: BulkOperation, p: BulkParams, snap: Snapshot | undefined): BulkParams | null {
  if (!snap) return null;
  const f = snap.fields;
  switch (op) {
    case 'assign': return { assigneeId: f.assignee?.id ?? null };
    case 'priority': return f.priority ? { priorityId: f.priority.id } : null;
    case 'label': return { set: [...f.labels] };
    case 'fixVersion': return { set: f.fixVersions.map((v: any) => v.id) };
    case 'component': return { set: f.components.map((v: any) => v.id) };
    case 'edit': {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(p.fields)) {
        if (k === 'priority') { if (f.priority) prev.priority = { id: f.priority.id }; else return null; }
        else if (k === 'assignee') prev.assignee = f.assignee ? { id: f.assignee.id } : null;
        else if (k === 'labels') prev.labels = [...f.labels];
        else if (k === 'components') prev.components = f.components.map((v: any) => ({ id: v.id }));
        else if (k === 'fixVersions') prev.fixVersions = f.fixVersions.map((v: any) => ({ id: v.id }));
        else if (k === 'versions') prev.versions = (f.versions ?? []).map((v: any) => ({ id: v.id }));
        else if (k === 'duedate') prev.duedate = f.duedate ?? null;
        else if (k === 'startdate') prev.startdate = f.startdate ?? null;
        else if (k === 'storyPoints') prev.storyPoints = f.storyPoints ?? null;
        else if (k === 'environment') prev.environment = f.environment ?? null;
      }
      return Object.keys(prev).length ? { fields: prev } : null;
    }
    default: return null;
  }
}

/** Runs one call through the normal API stack, with the caller's own credentials. */
async function replay(c: any, call: Call): Promise<{ ok: boolean; status: number; reason?: string }> {
  const { default: root } = await import('../app');
  const headers = new Headers(c.req.raw.headers);
  for (const h of ['content-length', 'accept-encoding', 'content-type', 'transfer-encoding']) headers.delete(h);
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(internalHeaders())) headers.set(k, v);
  const url = new URL(c.req.url);
  url.pathname = call.path;
  url.search = '';
  try {
    const res = await root.fetch(new Request(url, { method: call.method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) }));
    if (res.ok) return { ok: true, status: res.status };
    let body: any = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { ok: false, status: res.status, reason: reasonFromBody(res.status, body) };
  } catch (e: any) {
    return { ok: false, status: 500, reason: String(e?.message ?? 'Unexpected error').slice(0, 300) };
  }
}

/** Preview: everything that can be known without changing data. */
async function previewIssue(
  user: typeof schema.users.$inferSelect, op: BulkOperation, p: BulkParams, issue: IssueRow,
  can: ReturnType<typeof permissionChecker>, ctx: { sprints: Map<number, { state: string; projectId: number }>; targetCreate: Map<number, boolean | 'missing'> },
): Promise<string | null> {
  if (!(await can(issue.projectId, 'BROWSE_PROJECTS'))) return NOT_VISIBLE;
  const perm = PERMISSION[op];
  if (perm !== 'BROWSE_PROJECTS' && !(await can(issue.projectId, perm))) return 'Forbidden: you lack the required permission in this project';
  if (op === 'transition') {
    const available = await getAvailableTransitions(issue.id, user.id);
    const t = available.find((x) => x.id === p.transitionId);
    if (!t) return 'This transition is not available for the issue in its current status';
    const missing = t.meta.requiredFields.filter((f: string) => f === 'comment' ? !p.comment && p.fields?.comment === undefined : p.fields?.[f] === undefined);
    if (missing.length) return `Missing required ${missing.length > 1 ? 'fields' : 'field'}: ${missing.join(', ')}`;
  }
  if (op === 'move' && p.projectId !== issue.projectId) {
    const target = ctx.targetCreate.get(p.projectId);
    if (target === 'missing') return 'Target project not found';
    if (!target) return 'Forbidden: you may not create issues in the target project';
  }
  if (op === 'sprint' && p.sprintId !== null) {
    const s = ctx.sprints.get(p.sprintId);
    if (!s) return 'Sprint not found';
    if (s.state === 'closed') return 'Issues cannot be added to a closed sprint';
    if (s.projectId !== issue.projectId) return "Issue belongs to a different project than the sprint's board";
  }
  return null;
}

app.post('/rest/api/2/bulk/issues', requireAuth, async (c) => {
  const user = c.get('user')!;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400); }
  if (!body || typeof body !== 'object') return c.json({ errorMessages: ['Invalid body'] }, 400);

  const op = body.operation as BulkOperation;
  if (!BULK_OPERATIONS.includes(op)) return c.json({ errorMessages: [`operation must be one of: ${BULK_OPERATIONS.join(', ')}`] }, 400);
  const keysRes = normalizeIssueKeys(body.issueKeys);
  if (!keysRes.ok) return c.json({ errorMessages: [keysRes.error] }, 400);
  const parsed = parseBulkParams(op, body.params);
  if (!parsed.ok) return c.json({ errorMessages: [`Invalid params: ${parsed.error}`] }, 400);
  const keys = keysRes.keys;
  const params = parsed.params;
  const preview = c.req.query('preview') === 'true';

  const can = permissionChecker(user);
  const rows = await resolveIssues(keys, user.id);
  const failed: BulkFailure[] = [];
  const todo: IssueRow[] = [];
  for (const key of keys) {
    const row = rows.get(key);
    // The same answer for "missing" and "not browsable": existence must not leak.
    if (!row || !(await can(row.projectId, 'BROWSE_PROJECTS'))) failed.push({ key, reason: NOT_VISIBLE });
    else todo.push(row);
  }

  if (preview) {
    const sprints = new Map<number, { state: string; projectId: number }>();
    const targetCreate = new Map<number, boolean | 'missing'>();
    if (op === 'sprint' && params.sprintId !== null) {
      const [s] = await db.select({ state: schema.sprints.state, projectId: schema.boards.projectId }).from(schema.sprints)
        .innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId)).where(eq(schema.sprints.id, params.sprintId)).limit(1);
      if (s) sprints.set(params.sprintId, { state: s.state ?? "", projectId: s.projectId });
    }
    if (op === 'move') {
      const [t] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, params.projectId)).limit(1);
      targetCreate.set(params.projectId, t ? await can(params.projectId, 'CREATE_ISSUES') : 'missing');
    }
    const succeeded: string[] = [];
    await mapLimit(todo, 8, async (issue) => {
      const reason = await previewIssue(user, op, params, issue, can, { sprints, targetCreate });
      if (reason) failed.push({ key: issue.key, reason }); else succeeded.push(issue.key);
    });
    const order = new Map(keys.map((k, i) => [k, i]));
    succeeded.sort((a, b) => order.get(a)! - order.get(b)!);
    failed.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    return c.json({ preview: true, operation: op, total: keys.length, succeeded, failed, failureGroups: groupFailures(failed) });
  }

  // Old values for list operations and for "Undo".
  const snaps = new Map<string, Snapshot>();
  if (NEEDS_SNAPSHOT.has(op) && todo.length) {
    for (const s of await buildIssueResponses(todo.map((t) => t.id))) snaps.set(s.key.toUpperCase(), s);
  }

  const succeeded: string[] = [];
  const undoEntries: Array<{ key: string; params: BulkParams }> = [];
  await mapLimit(todo, CONCURRENCY, async (issue) => {
    const snap = snaps.get(issue.key.toUpperCase());
    const call = callFor(op, params, issue.key, snap);
    if (call) {
      const r = await replay(c, call);
      if (!r.ok) { failed.push({ key: issue.key, reason: r.reason ?? `Request failed (${r.status})` }); return; }
    }
    succeeded.push(issue.key);
    if (call && UNDOABLE.has(op)) {
      const u = undoParams(op, params, snap);
      if (u) undoEntries.push({ key: issue.key, params: u });
    }
  });

  const order = new Map(keys.map((k, i) => [k, i]));
  succeeded.sort((a, b) => order.get(a)! - order.get(b)!);
  failed.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  const undo: UndoGroup[] = UNDOABLE.has(op) ? groupUndo(op, undoEntries) : [];
  return c.json({ operation: op, total: keys.length, succeeded, failed, ...(undo.length ? { undo } : {}) });
});

/** Transitions available per issue and how many of the selected issues each applies to ("common" = all of them). */
app.post('/rest/api/2/bulk/issues/transitions', requireAuth, async (c) => {
  const user = c.get('user')!;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400); }
  const keysRes = normalizeIssueKeys(body?.issueKeys);
  if (!keysRes.ok) return c.json({ errorMessages: [keysRes.error] }, 400);
  const can = permissionChecker(user);
  const rows = await resolveIssues(keysRes.keys, user.id);
  const perIssue: Parameters<typeof mergeTransitions>[0] = [];
  const unavailable: BulkFailure[] = [];
  await mapLimit(keysRes.keys, 8, async (key) => {
    const row = rows.get(key);
    if (!row || !(await can(row.projectId, 'BROWSE_PROJECTS'))) { unavailable.push({ key, reason: NOT_VISIBLE }); return; }
    if (!(await can(row.projectId, 'TRANSITION_ISSUES'))) { unavailable.push({ key, reason: 'Forbidden: you lack the required permission in this project' }); return; }
    const ts = await getAvailableTransitions(row.id, user.id);
    perIssue.push({
      key: row.key,
      transitions: ts.map((t) => ({
        id: t.id, name: t.name, to: { id: t.to.id, name: t.to.name ?? '' },
        requiresComment: t.meta.requiresComment, requiresResolution: t.meta.requiresResolution,
      })),
    });
  });
  return c.json({ ...mergeTransitions(perIssue), unavailable });
});

export default app;
