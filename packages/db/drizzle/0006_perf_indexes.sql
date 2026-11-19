CREATE INDEX IF NOT EXISTS "comments_issue_created_idx" ON "comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_history_issue_created_idx" ON "issue_history" USING btree ("issue_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_created_idx" ON "issues" USING btree ("project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_updated_idx" ON "issues" USING btree ("project_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_status_idx" ON "issues" USING btree ("project_id","status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_assignee_open_idx" ON "issues" USING btree ("assignee_id","created_at" DESC NULLS LAST) WHERE resolution_id IS NULL;