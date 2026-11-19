import { describe, test, expect, afterAll } from 'bun:test';
import { createTestSql } from '../test-db';

// The list queries order by "x DESC" (PostgreSQL default NULLS FIRST). An index declared DESC NULLS LAST cannot serve
// that ordering, the planner falls back to a bitmap scan + sort (measured: docs/performance.md). Guard the definitions.
describe('performance indexes', () => {
  const sql = createTestSql();
  afterAll(async () => { await sql.end(); });

  test('ordered composite indexes exist and are not NULLS LAST', async () => {
    const names = ['issues_project_created_idx', 'issues_project_updated_idx', 'issues_assignee_open_idx', 'issue_history_issue_created_idx'];
    const rows = await sql`select indexname, indexdef from pg_indexes where indexname in ${sql(names)}`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([...names].sort());
    for (const r of rows) {
      expect(r.indexdef).toContain('DESC');
      expect(r.indexdef).not.toContain('NULLS LAST');
    }
  });

  test('"project ORDER BY created_at DESC, id DESC LIMIT" can use the composite index', async () => {
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_bitmapscan = off`;
      const plan = await tx`explain select id from issues where project_id = 1 order by created_at desc, id desc limit 50`;
      const text = plan.map((p) => Object.values(p)[0]).join('\n');
      expect(text).toContain('issues_project_created_idx');
      expect(text).not.toContain('Sort');
    });
  });
});
