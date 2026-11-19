import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import { getOrSet, generation } from '../services/cache';
import { issueVisibleSql } from '../security/issue-security';

export interface SearchResult {
  id: number;
  issueKey: string;
  summary: string;
  description: string | null;
  rank: number;
}

export async function setupFullTextSearch(): Promise<void> {
  // Add tsvector columns if they don't exist
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'issues' AND column_name = 'search_vector'
      ) THEN
        ALTER TABLE issues ADD COLUMN search_vector tsvector;
      END IF;
    END
    $$;
  `);

  // Create GIN index on search_vector
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS issues_search_vector_idx ON issues USING GIN (search_vector);
  `);

  // Create index on summary and description for tsvector generation
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS issues_summary_idx ON issues USING GIN (to_tsvector('english', summary));
  `);

  // Update search_vector for existing rows
  await db.execute(sql`
    UPDATE issues
    SET search_vector =
      setweight(to_tsvector('english', COALESCE(summary, '')), 'A') ||
      setweight(to_tsvector('english', COALESCE(description, '')), 'B')
    WHERE search_vector IS NULL;
  `);

  // Create trigger to keep search_vector updated
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION issues_search_vector_update()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'issues_search_vector_trigger'
      ) THEN
        CREATE TRIGGER issues_search_vector_trigger
        BEFORE INSERT OR UPDATE ON issues
        FOR EACH ROW
        EXECUTE FUNCTION issues_search_vector_update();
      END IF;
    END
    $$;
  `);
}

/**
 * Full-text search. `projectIds` (when given) restricts hits to those projects: callers must pass the projects the
 * user may browse, otherwise issues from projects they cannot see would be returned. `viewerId` applies the issue security
 * levels (null = anonymous) and is part of the cache key.
 */
export async function searchIssues(query: string, projectIds: number[] | undefined, viewerId: number | null): Promise<SearchResult[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const sanitized = query.trim().replace(/[^a-zA-Z0-9\s\-_]/g, ' ').trim();
  if (!sanitized) {
    return [];
  }

  if (projectIds && projectIds.length === 0) return [];
  const scopeKey = projectIds ? `:p${createHash('sha1').update(projectIds.join(',')).digest('hex').slice(0, 16)}` : '';
  const scopeSql = projectIds ? sql`AND project_id IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql``;

  return getOrSet(
    `veqsio:search:text:g${await generation('search')}.${await generation('security')}:u${viewerId ?? 'anon'}:${sanitized}${scopeKey}`,
    async () => {
      let results: unknown;
      try {
        results = await db.execute(sql`
        SELECT
          id,
          issue_key AS "issueKey",
          summary,
          description,
          ts_rank(search_vector, plainto_tsquery('english', ${sanitized})) AS rank
        FROM issues
        WHERE search_vector @@ plainto_tsquery('english', ${sanitized}) ${scopeSql} AND ${issueVisibleSql(viewerId)}
        ORDER BY rank DESC, created_at DESC
        LIMIT 100;
      `);
      } catch (e: any) {
        // search_vector exists only after the admin ran POST /rest/api/2/admin/search/setup. Until then fall back to a
        // plain substring search instead of failing every text query with a 500.
        const code = e?.cause?.code ?? e?.code;
        if (code !== '42703') throw e;
        const like = `%${sanitized.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
        results = await db.execute(sql`
        SELECT id, issue_key AS "issueKey", summary, description, 0 AS rank
        FROM issues
        WHERE (summary ILIKE ${like} OR description ILIKE ${like}) ${scopeSql} AND ${issueVisibleSql(viewerId)}
        ORDER BY created_at DESC
        LIMIT 100;
      `);
      }

      return (results as unknown[]).map((row: any) => ({
        id: row.id,
        issueKey: row.issueKey,
        summary: row.summary,
        description: row.description,
        rank: Number(row.rank),
      }));
    },
    'search'
  );
}
