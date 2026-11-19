CREATE TABLE "approval_approvers" (
	"approval_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "approval_approvers_approval_id_user_id_pk" PRIMARY KEY("approval_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"approval_id" integer NOT NULL,
	"approver_id" integer NOT NULL,
	"decision" varchar(20) NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"approver_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver_group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule" varchar(20) DEFAULT 'all' NOT NULL,
	"rule_threshold" integer,
	"auto_approve_when" jsonb,
	"auto_decline_when" jsonb,
	"reminder_interval_hours" integer,
	"expiry_hours" integer,
	"on_approved_transition_id" integer,
	"on_declined_transition_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"template_id" integer,
	"name" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"rule" varchar(20) DEFAULT 'all' NOT NULL,
	"rule_threshold" integer,
	"completed_by" varchar(20),
	"on_approved_transition_id" integer,
	"on_declined_transition_id" integer,
	"reminder_interval_hours" integer,
	"next_reminder_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_approvers" ADD CONSTRAINT "approval_approvers_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_approvers" ADD CONSTRAINT "approval_approvers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_templates" ADD CONSTRAINT "approval_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_template_id_approval_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."approval_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_approvers_user_idx" ON "approval_approvers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_uniq" ON "approval_decisions" USING btree ("approval_id","approver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_templates_project_name_uniq" ON "approval_templates" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "approvals_issue_idx" ON "approvals" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");