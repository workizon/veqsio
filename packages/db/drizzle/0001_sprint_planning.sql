ALTER TABLE "sprint_issues" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sprint_issues" ADD COLUMN "added_at" timestamp with time zone DEFAULT now();