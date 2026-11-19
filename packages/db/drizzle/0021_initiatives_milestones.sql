CREATE TABLE "initiative_epics" (
	"initiative_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "initiative_epics_initiative_id_issue_id_pk" PRIMARY KEY("initiative_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "initiative_projects" (
	"initiative_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "initiative_projects_initiative_id_project_id_pk" PRIMARY KEY("initiative_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "initiatives" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" integer,
	"status" varchar(20) DEFAULT 'planned' NOT NULL,
	"start_date" date,
	"target_date" date,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestone_issues" (
	"milestone_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_issues_milestone_id_issue_id_pk" PRIMARY KEY("milestone_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"target_date" date,
	"state" varchar(12) DEFAULT 'open' NOT NULL,
	"reached_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_status_updates" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_status_updates" ADD COLUMN "initiative_id" integer;--> statement-breakpoint
ALTER TABLE "initiative_epics" ADD CONSTRAINT "initiative_epics_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_epics" ADD CONSTRAINT "initiative_epics_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_issues" ADD CONSTRAINT "milestone_issues_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_issues" ADD CONSTRAINT "milestone_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "initiative_epics_issue_idx" ON "initiative_epics" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "initiative_projects_project_idx" ON "initiative_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "initiatives_owner_idx" ON "initiatives" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "milestone_issues_issue_idx" ON "milestone_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_name_idx" ON "milestones" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "project_status_updates" ADD CONSTRAINT "project_status_updates_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_status_updates_initiative_idx" ON "project_status_updates" USING btree ("initiative_id","created_at");