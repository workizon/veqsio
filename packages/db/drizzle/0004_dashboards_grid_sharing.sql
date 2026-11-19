CREATE TABLE "dashboard_favourites" (
	"dashboard_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "dashboard_favourites_dashboard_id_user_id_pk" PRIMARY KEY("dashboard_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "dashboard_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"dashboard_id" integer NOT NULL,
	"share_type" varchar(20) NOT NULL,
	"user_id" integer,
	"group_id" integer,
	"project_id" integer,
	"permission" varchar(10) DEFAULT 'view' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dashboard_user_prefs" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"default_dashboard_id" integer
);
--> statement-breakpoint
ALTER TABLE "dashboard_gadgets" ADD COLUMN "pos_x" integer;--> statement-breakpoint
ALTER TABLE "dashboard_gadgets" ADD COLUMN "pos_y" integer;--> statement-breakpoint
ALTER TABLE "dashboard_gadgets" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "dashboard_gadgets" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "icon" varchar(40);--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "refresh_interval" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "dashboard_favourites" ADD CONSTRAINT "dashboard_favourites_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_favourites" ADD CONSTRAINT "dashboard_favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_user_prefs" ADD CONSTRAINT "dashboard_user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_user_prefs" ADD CONSTRAINT "dashboard_user_prefs_default_dashboard_id_dashboards_id_fk" FOREIGN KEY ("default_dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_favourites_user_id_idx" ON "dashboard_favourites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dashboard_shares_dashboard_id_idx" ON "dashboard_shares" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboard_shares_user_id_idx" ON "dashboard_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dashboard_shares_group_id_idx" ON "dashboard_shares" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "dashboard_shares_project_id_idx" ON "dashboard_shares" USING btree ("project_id");