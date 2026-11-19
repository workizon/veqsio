import { db as defaultDb } from '../db';
import * as schema from '@veqsio/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { checkProjectPermission, checkGlobalPermission } from '../middleware/permissions';
import * as cache from '../services/cache';
import { invalidateIssueCache } from '../middleware/cache';
import { isResolvedState, labelsToDetach, type LabelDetail } from './labels';

// Accepts the shared client or a transaction handle.
type Executor = any;

/** Finds or creates labels by name (create-on-type) and returns their ids in input order. */
export async function ensureLabelIds(names: string[], executor: Executor = defaultDb): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const existing = await executor.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name)).limit(1);
    if (existing[0]) {
      ids.push(existing[0].id);
      continue;
    }
    const [created] = await executor.insert(schema.labels).values({ name }).onConflictDoNothing().returning({ id: schema.labels.id });
    if (created) {
      ids.push(created.id);
    } else {
      const again = await executor.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name)).limit(1);
      if (again[0]) ids.push(again[0].id);
    }
  }
  return ids;
}

/** Colour data for the labels of many issues, additive `labelDetails` for the issue JSON. */
export async function getLabelDetailsForIssues(issueIds: number[]): Promise<Map<number, LabelDetail[]>> {
  const out = new Map<number, LabelDetail[]>();
  if (issueIds.length === 0) return out;
  const rows = await defaultDb
    .select({
      issueId: schema.issueLabels.issueId,
      name: schema.labels.name,
      color: schema.labels.color,
      removeOnResolve: schema.labels.removeOnResolve,
    })
    .from(schema.issueLabels)
    .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
    .where(inArray(schema.issueLabels.issueId, issueIds));
  for (const r of rows) {
    const list = out.get(r.issueId) ?? [];
    list.push({ name: r.name, color: r.color, removeOnResolve: r.removeOnResolve });
    out.set(r.issueId, list);
  }
  return out;
}

/**
 * Detaches labels flagged "remove on resolution" from an issue and records it in the history.
 * Returns the removed label names. Pass the transaction when called inside one.
 */
export async function removeResolutionLabels(issueId: number, userId: number | null, executor: Executor = defaultDb): Promise<string[]> {
  const rows: { id: number; name: string; removeOnResolve: boolean }[] = await executor
    .select({ id: schema.labels.id, name: schema.labels.name, removeOnResolve: schema.labels.removeOnResolve })
    .from(schema.issueLabels)
    .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
    .where(eq(schema.issueLabels.issueId, issueId));
  const doomed = labelsToDetach(rows);
  if (doomed.length === 0) return [];
  const remaining = rows.filter((r) => !r.removeOnResolve).map((r) => r.name).sort();
  await executor.delete(schema.issueLabels).where(and(eq(schema.issueLabels.issueId, issueId), inArray(schema.issueLabels.labelId, doomed.map((d) => d.id))));
  await executor.insert(schema.issueHistory).values({
    issueId,
    fieldName: 'labels',
    oldValue: rows.map((r) => r.name).sort().join(','),
    newValue: remaining.join(','),
    authorId: userId,
  });
  return doomed.map((d) => d.name);
}

/**
 * Applies remove-on-resolution if the issue is now resolved: in a done-category status, or (when
 * `viaResolution` is set, i.e. a resolution was just written) carrying a resolution.
 */
export async function removeResolutionLabelsIfResolved(
  issueId: number,
  userId: number | null,
  executor: Executor = defaultDb,
  opts: { viaResolution?: boolean } = {},
): Promise<string[]> {
  const [issue] = await executor.select({ statusId: schema.issues.statusId, resolutionId: schema.issues.resolutionId }).from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
  if (!issue) return [];
  const [status] = await executor.select({ category: schema.statuses.category }).from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1);
  if (!isResolvedState(status?.category, opts.viaResolution ? issue.resolutionId : null)) return [];
  return removeResolutionLabels(issueId, userId, executor);
}

/** Labels are global, so management needs system admin or PROJECT_ADMIN on at least one project. */
export async function canManageLabels(user: typeof schema.users.$inferSelect | null): Promise<boolean> {
  if (!user) return false;
  if (await checkGlobalPermission(user, 'ADMINISTER')) return true;
  const projects = await defaultDb.select({ id: schema.projects.id }).from(schema.projects);
  for (const p of projects) {
    if (await checkProjectPermission(user, p.id, 'PROJECT_ADMIN')) return true;
  }
  return false;
}

export async function listLabelsWithCounts() {
  return defaultDb
    .select({
      id: schema.labels.id,
      name: schema.labels.name,
      color: schema.labels.color,
      removeOnResolve: schema.labels.removeOnResolve,
      issueCount: sql<number>`(select count(*)::int from issue_labels il where il.label_id = ${schema.labels.id})`,
    })
    .from(schema.labels)
    .orderBy(schema.labels.name);
}

/** Label colour, name or membership changed globally: drop cached issue payloads and search results. */
export async function invalidateLabelCaches(): Promise<void> {
  await cache.delPattern('veqsio:issue:*');
  await invalidateIssueCache();
}
