CREATE TABLE "page_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"parent_id" integer,
	"author_id" integer,
	"body" text NOT NULL,
	"quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_issue_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"quote" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"author_id" integer,
	"added_lines" integer DEFAULT 0 NOT NULL,
	"removed_lines" integer DEFAULT 0 NOT NULL,
	"restored_from" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"parent_id" integer,
	"title" varchar(255) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_id" integer,
	"updated_by" integer,
	"locked" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_parent_id_page_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."page_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_issue_links" ADD CONSTRAINT "page_issue_links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_issue_links" ADD CONSTRAINT "page_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_issue_links" ADD CONSTRAINT "page_issue_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_comments_page_idx" ON "page_comments" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_issue_links_page_issue_uniq" ON "page_issue_links" USING btree ("page_id","issue_id");--> statement-breakpoint
CREATE INDEX "page_issue_links_issue_idx" ON "page_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_page_version_uniq" ON "page_versions" USING btree ("page_id","version");--> statement-breakpoint
CREATE INDEX "pages_tree_idx" ON "pages" USING btree ("project_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "pages_author_idx" ON "pages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "pages_fts_idx" ON "pages" USING gin (to_tsvector('simple', "title" || ' ' || "body"));