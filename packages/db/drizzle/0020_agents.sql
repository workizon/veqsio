CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"trigger" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"triggered_by" integer,
	"chain_depth" integer DEFAULT 0 NOT NULL,
	"delivery_id" varchar(64),
	"token_hash" varchar(128),
	"token_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"summary" text,
	"result_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_id" integer,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"webhook_url" text,
	"signing_secret_enc" text,
	"triggers" jsonb DEFAULT '["assigned","mentioned"]'::jsonb NOT NULL,
	"max_concurrent_runs" integer DEFAULT 3 NOT NULL,
	"max_runs_per_issue" integer DEFAULT 1 NOT NULL,
	"max_runs_per_hour" integer DEFAULT 30 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_agent_created_idx" ON "agent_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_issue_idx" ON "agent_runs" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_token_hash_idx" ON "agent_runs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agents_owner_id_idx" ON "agents" USING btree ("owner_id");