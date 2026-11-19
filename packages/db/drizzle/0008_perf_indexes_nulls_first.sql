-- 0006 created these indexes with DESC NULLS LAST, but queries order by "x DESC" (PostgreSQL default: NULLS FIRST), so the planner could not use them for ORDER BY ... LIMIT. Recreate with NULLS FIRST (same as sql/001_perf_indexes.sql).
DROP INDEX IF EXISTS "issue_history_issue_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "issues_project_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "issues_project_updated_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "issues_assignee_open_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_history_issue_created_idx" ON "issue_history" USING btree ("issue_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_created_idx" ON "issues" USING btree ("project_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_updated_idx" ON "issues" USING btree ("project_id","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_assignee_open_idx" ON "issues" USING btree ("assignee_id","created_at" DESC NULLS FIRST) WHERE resolution_id IS NULL;