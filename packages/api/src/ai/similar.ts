/**
 * Similar / duplicate issue detection WITHOUT any LLM: PostgreSQL full-text ranking over summary + description.
 * Candidates are restricted to projects the caller may browse, so nothing hidden can leak. Only key, summary,
 * project key and status are returned (no description text).
 */
import { sql } from 'drizzle-orm';
import { issueVisibleSql } from '../security/issue-security';
import { db } from '../db';

export interface SimilarIssue { key: string; summary: string; projectKey: string; status: string; score: number }

const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'this', 'that', 'with', 'from', 'when', 'what', 'will', 'would', 'there', 'their', 'been', 'into', 'than', 'then', 'them', 'some', 'does', 'did', 'doesn', 'isn', 'should', 'could', 'about', 'after', 'also', 'just', 'like', 'only', 'please']);

/** Distinct meaningful words, summary words first, capped. Letters and digits only, so the query can never contain operators. */
export function extractTerms(summary: string, description: string | null | undefined, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (text: string, limit: number) => {
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu) ?? []) {
      if (STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= limit) return;
    }
  };
  add(summary.slice(0, 500), max);
  add((description ?? '').slice(0, 2000), max);
  return out;
}

async function hasSearchVector(): Promise<boolean> {
  const rows = await db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'search_vector' LIMIT 1`);
  return (rows as unknown as unknown[]).length > 0;
}

export async function findSimilarIssues(opts: {
  summary: string;
  description?: string | null;
  browsableProjectIds: number[];
  /** Who asks: issue security levels apply (null = anonymous). */
  viewerId: number | null;
  excludeIssueId?: number;
  limit?: number;
}): Promise<SimilarIssue[]> {
  const terms = extractTerms(opts.summary, opts.description);
  if (terms.length === 0 || opts.browsableProjectIds.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const query = terms.join(' or ');
  const ids = sql.join(opts.browsableProjectIds.map((id) => sql`${id}`), sql`, `);
  const vec = (await hasSearchVector())
    ? sql`COALESCE(i.search_vector, setweight(to_tsvector('english', i.summary), 'A') || setweight(to_tsvector('english', COALESCE(i.description, '')), 'B'))`
    : sql`(setweight(to_tsvector('english', i.summary), 'A') || setweight(to_tsvector('english', COALESCE(i.description, '')), 'B'))`;
  const exclude = opts.excludeIssueId !== undefined ? sql`AND i.id <> ${opts.excludeIssueId}` : sql``;

  const rows = await db.execute(sql`
    SELECT i.issue_key AS "key", i.summary AS summary, p.project_key AS "projectKey", s.name AS status,
           ts_rank(${vec}, q.q, 32) AS score
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    JOIN statuses s ON s.id = i.status_id,
         websearch_to_tsquery('english', ${query}) AS q(q)
    WHERE i.project_id IN (${ids}) AND ${issueVisibleSql(opts.viewerId, 'i')} ${exclude} AND ${vec} @@ q.q
    ORDER BY score DESC, i.id DESC
    LIMIT ${limit}
  `);
  return (rows as unknown as any[]).map((r) => ({
    key: r.key, summary: r.summary, projectKey: r.projectKey, status: r.status, score: Math.round(Number(r.score) * 1000) / 1000,
  }));
}
