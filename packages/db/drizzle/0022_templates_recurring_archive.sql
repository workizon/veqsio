CREATE TABLE "issue_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"name" varchar(100) NOT NULL,
	"description" text,
	"issue_type_id" integer,
	"summary_pattern" varchar(255) DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"priority_id" integer,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"component_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_id" integer,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_issue_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"recurring_id" integer NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"issue_id" integer,
	"issue_key" varchar(60),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"template_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"frequency" varchar(10) NOT NULL,
	"days_of_week" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"day_of_month" smallint,
	"time_of_day" varchar(5) DEFAULT '09:00' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"owner_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_by" integer;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_priority_id_priorities_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."priorities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issue_runs" ADD CONSTRAINT "recurring_issue_runs_recurring_id_recurring_issues_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issue_runs" ADD CONSTRAINT "recurring_issue_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issues" ADD CONSTRAINT "recurring_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issues" ADD CONSTRAINT "recurring_issues_template_id_issue_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."issue_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issues" ADD CONSTRAINT "recurring_issues_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_templates_project_idx" ON "issue_templates" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_issue_runs_slot_uniq" ON "recurring_issue_runs" USING btree ("recurring_id","slot_at");--> statement-breakpoint
CREATE INDEX "recurring_issues_project_idx" ON "recurring_issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "recurring_issues_due_idx" ON "recurring_issues" USING btree ("active","next_run_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;