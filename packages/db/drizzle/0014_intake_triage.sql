CREATE TABLE "intake_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"requester_name" varchar(255),
	"requester_email" varchar(255),
	"requester_user_id" integer,
	"source" varchar(10) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"snoozed_until" timestamp with time zone,
	"accepted_issue_id" integer,
	"duplicate_of_issue_id" integer,
	"source_ref" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"slug" varchar(64) NOT NULL,
	"public_form_enabled" boolean DEFAULT false NOT NULL,
	"form_title" varchar(120) DEFAULT '' NOT NULL,
	"form_intro" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '{"name":"optional","email":"optional","description":"optional"}'::jsonb NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"email_secret_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_settings_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "intake_settings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_accepted_issue_id_issues_id_fk" FOREIGN KEY ("accepted_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_duplicate_of_issue_id_issues_id_fk" FOREIGN KEY ("duplicate_of_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_settings" ADD CONSTRAINT "intake_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_items_project_status_idx" ON "intake_items" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "intake_items_snoozed_until_idx" ON "intake_items" USING btree ("snoozed_until");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_items_source_ref_idx" ON "intake_items" USING btree ("project_id","source_ref");