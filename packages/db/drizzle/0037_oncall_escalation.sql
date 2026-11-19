ALTER TABLE "oncall_alerts" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oncall_alerts" ADD COLUMN "escalated_user_id" integer;--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD COLUMN "escalation_minutes" integer;--> statement-breakpoint
ALTER TABLE "oncall_schedules" ADD COLUMN "escalation_schedule_id" integer;--> statement-breakpoint
ALTER TABLE "oncall_alerts" ADD CONSTRAINT "oncall_alerts_escalated_user_id_users_id_fk" FOREIGN KEY ("escalated_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;