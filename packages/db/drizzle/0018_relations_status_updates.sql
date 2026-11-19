CREATE TABLE "project_status_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"issue_id" integer,
	"state" varchar(20) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_types" ADD COLUMN "scheduling" varchar(20);--> statement-breakpoint
ALTER TABLE "link_types" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_status_updates" ADD CONSTRAINT "project_status_updates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_updates" ADD CONSTRAINT "project_status_updates_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_updates" ADD CONSTRAINT "project_status_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_status_updates_project_idx" ON "project_status_updates" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_status_updates_issue_idx" ON "project_status_updates" USING btree ("issue_id","created_at");--> statement-breakpoint
-- Built-in link types (additive): mark the existing ones, add "Implements" and the two dependency scheduling types.
UPDATE "link_types" SET "is_system" = true WHERE "name" IN ('Blocks', 'Cloners', 'Duplicate', 'Relates');--> statement-breakpoint
INSERT INTO "link_types" ("name", "inward", "outward", "is_system")
SELECT v.name, v.inward, v.outward, true FROM (VALUES
  ('Blocks', 'is blocked by', 'blocks'),
  ('Cloners', 'is cloned by', 'clones'),
  ('Duplicate', 'is duplicated by', 'duplicates'),
  ('Relates', 'relates to', 'relates to'),
  ('Implements', 'is implemented by', 'implements')
) AS v(name, inward, outward)
WHERE NOT EXISTS (SELECT 1 FROM "link_types" l WHERE lower(l."name") = lower(v.name));--> statement-breakpoint
INSERT INTO "link_types" ("name", "inward", "outward", "scheduling", "is_system")
SELECT 'Starts before', 'starts after', 'starts before', 'starts_before', true
WHERE NOT EXISTS (SELECT 1 FROM "link_types" WHERE lower("name") = 'starts before');--> statement-breakpoint
INSERT INTO "link_types" ("name", "inward", "outward", "scheduling", "is_system")
SELECT 'Finishes before', 'finishes after', 'finishes before', 'finishes_before', true
WHERE NOT EXISTS (SELECT 1 FROM "link_types" WHERE lower("name") = 'finishes before');--> statement-breakpoint
-- Exactly one default workflow: keep the lowest id if an old database has several.
UPDATE "workflows" SET "is_default" = false WHERE "is_default" = true AND "id" <> (SELECT min("id") FROM "workflows" WHERE "is_default" = true);--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_one_default_idx" ON "workflows" USING btree ("is_default") WHERE "workflows"."is_default" = true;