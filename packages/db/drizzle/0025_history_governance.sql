CREATE TABLE "workflow_change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"actor_id" integer,
	"target_type" varchar(30) NOT NULL,
	"action" varchar(20) NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "statuses" ADD COLUMN "allow_new_issues" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_change_log" ADD CONSTRAINT "workflow_change_log_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_change_log" ADD CONSTRAINT "workflow_change_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_change_log_workflow_created_idx" ON "workflow_change_log" USING btree ("workflow_id","created_at" DESC NULLS FIRST);