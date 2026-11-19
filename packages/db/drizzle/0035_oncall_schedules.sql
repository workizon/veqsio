CREATE TABLE "oncall_members" (
	"schedule_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "oncall_members_schedule_id_user_id_pk" PRIMARY KEY("schedule_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "oncall_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" integer
);
--> statement-breakpoint
CREATE TABLE "oncall_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"rotation_hours" integer DEFAULT 168 NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oncall_members" ADD CONSTRAINT "oncall_members_schedule_id_oncall_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_members" ADD CONSTRAINT "oncall_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_schedule_id_oncall_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oncall_overrides_schedule_idx" ON "oncall_overrides" USING btree ("schedule_id","starts_at");