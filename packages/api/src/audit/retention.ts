import { and, lt, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { hasFeature } from '../license';
import { getInstanceSettings } from '../settings/instance';

const BATCH = 5000;
const MAX_BATCHES = 40; // at most 200,000 rows per run; the next run continues

/** Rows older than this many days are due for deletion. */
export const cutoffFor = (days: number, now = new Date()) => new Date(now.getTime() - days * 86_400_000);

/**
 * Deletes audit entries older than the configured retention. Needs the audit_retention licence feature and a
 * positive number of days (0 = keep everything); without either nothing is deleted. One audit entry records each
 * cleanup that removed something, so the log itself shows that and when it was trimmed. Returns how many rows went.
 */
export async function runAuditRetention(now = new Date()): Promise<number> {
  if (!hasFeature('audit_retention')) return 0;
  const days = Number((await getInstanceSettings()).auditRetentionDays) || 0;
  if (days <= 0) return 0;
  const cutoff = cutoffFor(days, now);
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await db.execute(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ${cutoff.toISOString()}::timestamptz ORDER BY id LIMIT ${BATCH}) RETURNING id`) as unknown as unknown[];
    removed += res.length;
    if (res.length < BATCH) break;
  }
  if (removed > 0) {
    await db.insert(schema.auditLog).values({ action: 'audit.retention', targetType: 'audit_log', target: null, actorName: 'system', details: { removed, olderThan: cutoff.toISOString(), retentionDays: days } });
  }
  return removed;
}
