-- Performance indexes for large installations (100k+ issues). Idempotent.
--
-- Migration 0006_perf_indexes creates the same indexes (IF NOT EXISTS) when `bun migrate.ts` runs; on a
-- large production table apply THIS file first (before upgrading), because
-- CREATE INDEX CONCURRENTLY does not block writes:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/001_perf_indexes.sql
--
-- Run it with psql in autocommit mode (not inside a transaction block: CONCURRENTLY forbids that). If a build
-- is interrupted PostgreSQL leaves an INVALID index behind; drop it (DROP INDEX CONCURRENTLY name) and re-run.
-- Measured effect: see docs/performance.md. (Migration 0008 recreates the ordered indexes as DESC NULLS FIRST; on an installation that already ran 0006, drop the NULLS LAST variants before running this file.)

-- Issue lists per project ordered by creation / update (project issue list, backlog, board, JQL "project = X ORDER BY ...").
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_project_created_idx ON issues (project_id, created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_project_updated_idx ON issues (project_id, updated_at DESC, id DESC);
-- "project = X AND status = Y" (board columns, JQL).
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_project_status_idx ON issues (project_id, status_id);
-- "assignee = currentUser() AND resolution = Unresolved" (my open issues, dashboards).
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_assignee_open_idx ON issues (assignee_id, created_at DESC) WHERE resolution_id IS NULL;

-- Ordered comment / history lookups for one issue (issue detail page).
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_issue_created_idx ON comments (issue_id, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS issue_history_issue_created_idx ON issue_history (issue_id, created_at DESC);

-- Substring search ("summary ~ foo", "text ~ foo") uses ILIKE '%foo%', which b-tree indexes cannot serve.
-- pg_trgm makes it index-assisted. CREATE EXTENSION needs the extension package (postgresql-contrib on Debian;
-- bundled in the official postgres image) and, on PostgreSQL < 13, superuser rights. Skip this block if you
-- cannot install it: everything else works, substring searches just scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_summary_trgm_idx ON issues USING gin (summary gin_trgm_ops);
