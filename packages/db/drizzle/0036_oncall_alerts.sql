CREATE TABLE "oncall_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"dedup_key" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"severity" varchar(10) DEFAULT 'high' NOT NULL,
	"status" varchar(15) DEFAULT 'open' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"notified_user_id" integer,
	"acknowledged_by" integer,
	"acknowledged_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD COLUMN "integration_key_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "oncall_alerts" ADD CONSTRAINT "oncall_alerts_schedule_id_oncall_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."oncall_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_alerts" ADD CONSTRAINT "oncall_alerts_notified_user_id_users_id_fk" FOREIGN KEY ("notified_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_alerts" ADD CONSTRAINT "oncall_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oncall_alerts_schedule_idx" ON "oncall_alerts" USING btree ("schedule_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "oncall_alerts_open_uniq" ON "oncall_alerts" USING btree ("schedule_id","dedup_key") WHERE status <> 'closed';--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD CONSTRAINT "oncall_schedules_integration_key_hash_unique" UNIQUE("integration_key_hash");