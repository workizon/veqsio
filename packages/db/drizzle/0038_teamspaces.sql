CREATE TABLE "teamspace_members" (
	"teamspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "teamspace_members_teamspace_id_user_id_pk" PRIMARY KEY("teamspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teamspace_projects" (
	"teamspace_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	CONSTRAINT "teamspace_projects_teamspace_id_project_id_pk" PRIMARY KEY("teamspace_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "teamspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"lead_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teamspace_members" ADD CONSTRAINT "teamspace_members_teamspace_id_teamspaces_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."teamspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspace_members" ADD CONSTRAINT "teamspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspace_projects" ADD CONSTRAINT "teamspace_projects_teamspace_id_teamspaces_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."teamspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspace_projects" ADD CONSTRAINT "teamspace_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspaces" ADD CONSTRAINT "teamspaces_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspaces" ADD CONSTRAINT "teamspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teamspace_members_user_idx" ON "teamspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teamspace_projects_project_idx" ON "teamspace_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teamspaces_name_uniq" ON "teamspaces" USING btree (lower("name"));