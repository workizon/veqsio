import { sql } from 'drizzle-orm';
import { db } from '../db';

const SLOW_QUERY_THRESHOLD_MS = 500;

interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export async function getConnectionPoolStats(): Promise<PoolStats | null> {
  try {
    const result = await db.execute(sql`SELECT
      count(*)::int as total_count,
      count(*) FILTER (WHERE state = 'idle')::int as idle_count,
      count(*) FILTER (WHERE state = 'active')::int as active_count,
      count(*) FILTER (WHERE wait_event_type = 'Client')::int as waiting_count
      FROM pg_stat_activity
      WHERE datname = current_database()`);

    const row = result[0] as Record<string, number> | undefined;
    if (!row) return null;

    return {
      totalCount: row.total_count ?? 0,
      idleCount: row.idle_count ?? 0,
      waitingCount: row.waiting_count ?? 0,
    };
  } catch {
    return null;
  }
}

export interface MissingIndex {
  tableName: string;
  columnName: string;
  indexScanRatio: number;
  estimatedRows: number;
}

export async function analyzeMissingIndexes(): Promise<MissingIndex[]> {
  const query = sql`
    SELECT
      schemaname || '.' || relname AS table_name,
      indexrelname AS index_name,
      pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
      idx_scan AS index_scans,
      idx_tup_read AS tuples_read,
      idx_tup_fetch AS tuples_fetched
    FROM pg_stat_user_indexes
    JOIN pg_index USING (indexrelid)
    WHERE schemaname = 'public'
    ORDER BY idx_scan, pg_relation_size(indexrelid) DESC;
  `;

  const result = await db.execute(query);
  const indexes = result as Array<Record<string, unknown>>;

  // Find tables with high sequential scan ratios and missing indexes
  const missingQuery = sql`
    SELECT
      relname AS table_name,
      seq_scan - idx_scan AS too_much_seq,
      CASE WHEN seq_scan > 0 THEN round(idx_scan::numeric / seq_scan::numeric, 2) ELSE 0 END AS idx_scan_ratio,
      n_live_tup AS estimated_rows
    FROM pg_stat_user_tables
    WHERE seq_scan > 0
      AND n_live_tup > 1000
      AND (idx_scan IS NULL OR seq_scan > idx_scan * 5)
    ORDER BY too_much_seq DESC
    LIMIT 20;
  `;

  const missingResult = await db.execute(missingQuery);
  const missingRows = missingResult as Array<Record<string, unknown>>;

  return missingRows.map((row) => ({
    tableName: String(row.table_name ?? 'unknown'),
    columnName: 'unknown', // pg_stat_user_tables doesn't expose columns; manual analysis needed
    indexScanRatio: Number(row.idx_scan_ratio ?? 0),
    estimatedRows: Number(row.estimated_rows ?? 0),
  }));
}

export function withSlowQueryLogger<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  label: string
): T {
  return (async (...args: any[]) => {
    const start = performance.now();
    try {
      return await fn(...args);
    } finally {
      const duration = performance.now() - start;
      if (duration > SLOW_QUERY_THRESHOLD_MS) {
        console.warn(`[SLOW QUERY] ${label} took ${Math.round(duration)}ms`, { args });
      }
    }
  }) as T;
}
