CREATE TABLE "push_preferences" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"events" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quiet_enabled" boolean DEFAULT false NOT NULL,
	"quiet_start" varchar(5) DEFAULT '22:00' NOT NULL,
	"quiet_end" varchar(5) DEFAULT '07:00' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_preferences" ADD CONSTRAINT "push_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;