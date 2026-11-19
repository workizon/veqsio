CREATE TABLE "inbound_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"reason" text,
	"idempotency_key" varchar(200),
	"dedup_key" varchar(300),
	"issue_id" integer,
	"payload" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"dedup_key" varchar(300) NOT NULL,
	"issue_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"type" varchar(20) DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_mode" varchar(20) DEFAULT 'hmac' NOT NULL,
	"secret_enc" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issue_type_id" integer,
	"actor_user_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"type" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"url_enc" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"event" varchar(50) NOT NULL,
	"status" varchar(20) NOT NULL,
	"response_status" integer,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_deliveries" ADD CONSTRAINT "inbound_deliveries_source_id_inbound_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbound_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_deliveries" ADD CONSTRAINT "inbound_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_links" ADD CONSTRAINT "inbound_links_source_id_inbound_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbound_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_links" ADD CONSTRAINT "inbound_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_deliveries_source_idx" ON "inbound_deliveries" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_deliveries_idem_idx" ON "inbound_deliveries" USING btree ("source_id","idempotency_key") WHERE "inbound_deliveries"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_links_source_key_idx" ON "inbound_links" USING btree ("source_id","dedup_key");--> statement-breakpoint
CREATE INDEX "inbound_links_issue_idx" ON "inbound_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "inbound_sources_project_idx" ON "inbound_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_sources_project_name_idx" ON "inbound_sources" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "notification_channels_project_idx" ON "notification_channels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries" USING btree ("channel_id","created_at");