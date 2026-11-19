import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { parseJQLSafe } from '../jql';
import { buildJQLContext } from '../routes/search';
import { getBrowsableProjectIds } from './browse';
import { issueVisibleSql } from '../security/issue-security';
import { getVisibleFilter } from './filter-access';
import { queueEmails } from './email';
import { isSubscriptionDue, type DueInput } from './filter-schedule';

export { currentPeriodStart, isSubscriptionDue, type DueInput } from './filter-schedule';

export const DIGEST_MAX_ISSUES = 50;

const baseUrl = () => (process.env.BASE_URL || process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '');

export interface DigestResult {
  due: number;
  sent: number;
  skippedEmpty: number;
  failed: number;
}

/**
 * Send digests for all due subscriptions. The filter's JQL is executed AS THE SUBSCRIBER and trimmed to
 * projects they may browse. A subscription is claimed (last_sent_at updated atomically) before the email
 * is queued, so overlapping runs never double-send; the trade-off is at-most-once delivery.
 */
export async function runFilterDigests(now: Date = new Date()): Promise<DigestResult> {
  const result: DigestResult = { due: 0, sent: 0, skippedEmpty: 0, failed: 0 };
  const rows = await db.select({ sub: schema.filterSubscriptions, user: schema.users })
    .from(schema.filterSubscriptions)
    .innerJoin(schema.users, eq(schema.users.id, schema.filterSubscriptions.userId))
    .where(eq(schema.users.active, true));

  for (const { sub, user } of rows) {
    const subInput: DueInput = { ...sub, createdAt: sub.createdAt ?? new Date(0) };
    if (!isSubscriptionDue(subInput, now)) continue;
    result.due++;
    try {
      // Atomic claim: only one runner wins this period.
      const claimed = await db.update(schema.filterSubscriptions)
        .set({ lastSentAt: now })
        .where(and(
          eq(schema.filterSubscriptions.id, sub.id),
          sql`${schema.filterSubscriptions.lastSentAt} IS NOT DISTINCT FROM ${sub.lastSentAt ? sub.lastSentAt.toISOString() : null}::timestamptz`,
        ))
        .returning({ id: schema.filterSubscriptions.id });
      if (claimed.length === 0) continue;

      const access = await getVisibleFilter(user, sub.filterId);
      if (!access) {
        // The filter was unshared or deleted-from-view: drop the subscription.
        await db.delete(schema.filterSubscriptions).where(eq(schema.filterSubscriptions.id, sub.id));
        continue;
      }

      const projectIds = await getBrowsableProjectIds(user);
      let issues: { key: string; summary: string; status: string; url: string }[] = [];
      let total = 0;
      if (projectIds.length > 0) {
        const parsed = parseJQLSafe(access.filter.jql, await buildJQLContext(user));
        if (!parsed.success) {
          result.failed++;
          continue;
        }
        const { where, orderBy } = parsed.result;
        const secure = issueVisibleSql(user.id);
        const scope = where ? and(where, inArray(schema.issues.projectId, projectIds), secure) : and(inArray(schema.issues.projectId, projectIds), secure);
        const found = await db.select({
          key: schema.issues.issueKey, summary: schema.issues.summary, status: schema.statuses.name,
        })
          .from(schema.issues)
          .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
          .where(scope)
          .orderBy(...(orderBy.length ? orderBy : [desc(schema.issues.createdAt)]))
          .limit(DIGEST_MAX_ISSUES);
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issues).where(scope);
        total = Number(n);
        issues = found.map((i) => ({ key: i.key, summary: i.summary, status: i.status, url: `${baseUrl()}/issues/${i.key}` }));
      }

      if (total === 0 && sub.emptyPolicy !== 'send') {
        result.skippedEmpty++;
        continue;
      }
      await queueEmails([user.email], 'filter-digest', {
        filterName: access.filter.name,
        total,
        shown: issues.length,
        issues,
        filterUrl: `${baseUrl()}/issues?jql=${encodeURIComponent(access.filter.jql)}`,
      });
      result.sent++;
    } catch (e) {
      result.failed++;
      console.error(`[filter-digest] subscription ${sub.id} failed:`, e);
    }
  }
  return result;
}
