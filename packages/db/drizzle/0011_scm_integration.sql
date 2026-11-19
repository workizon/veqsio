CREATE TABLE "scm_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"ref" varchar(255) NOT NULL,
	"branch" varchar(255),
	"title" text,
	"url" text,
	"status" varchar(20),
	"build_status" varchar(20),
	"author" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scm_repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"provider" varchar(20) NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"name" varchar(255) NOT NULL,
	"default_branch" varchar(255) DEFAULT 'main' NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"access_token_enc" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "scm_links" ADD CONSTRAINT "scm_links_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_links" ADD CONSTRAINT "scm_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_repositories" ADD CONSTRAINT "scm_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_repositories" ADD CONSTRAINT "scm_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scm_links_unique_idx" ON "scm_links" USING btree ("repository_id","issue_id","kind","ref");--> statement-breakpoint
CREATE INDEX "scm_links_issue_idx" ON "scm_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "scm_repositories_project_idx" ON "scm_repositories" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scm_repositories_provider_name_idx" ON "scm_repositories" USING btree ("provider","base_url","name");