CREATE TABLE "sd_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" varchar(30) NOT NULL,
	"threshold" integer,
	"action" varchar(30) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sd_automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"outcome" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sd_automation_rules" ADD CONSTRAINT "sd_automation_rules_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_automation_rules" ADD CONSTRAINT "sd_automation_rules_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_automation_runs" ADD CONSTRAINT "sd_automation_runs_rule_id_sd_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sd_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_automation_runs" ADD CONSTRAINT "sd_automation_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sd_automation_rules_desk_idx" ON "sd_automation_rules" USING btree ("service_desk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sd_automation_runs_uniq" ON "sd_automation_runs" USING btree ("rule_id","issue_id");