CREATE TABLE "ai_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" varchar(20) DEFAULT 'openai' NOT NULL,
	"base_url" text,
	"model" varchar(200),
	"api_key_encrypted" text,
	"max_input_chars" integer DEFAULT 12000 NOT NULL,
	"daily_request_limit_per_user" integer DEFAULT 50 NOT NULL,
	"features" jsonb DEFAULT '{"classify":true,"summarize":true,"similar":true,"release_notes":true}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"feature" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer
);
--> statement-breakpoint
CREATE TABLE "filter_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"filter_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"schedule" varchar(10) NOT NULL,
	"hour" smallint DEFAULT 8 NOT NULL,
	"weekday" smallint,
	"empty_policy" varchar(10) DEFAULT 'skip' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(40) NOT NULL,
	"issuer" varchar(500) NOT NULL,
	"client_id" varchar(500) NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"scopes" varchar(500) DEFAULT 'openid profile email' NOT NULL,
	"email_claim" varchar(100) DEFAULT 'email' NOT NULL,
	"name_claim" varchar(100) DEFAULT 'name' NOT NULL,
	"groups_claim" varchar(100),
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_provision" boolean DEFAULT false NOT NULL,
	"link_by_email" boolean DEFAULT false NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "plugin_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" integer NOT NULL,
	"delivery_id" varchar(64) NOT NULL,
	"event" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"response_status" integer,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" integer NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(64) NOT NULL,
	"manifest" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"installed_by" integer,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" varchar(128),
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_user_id" integer,
	"signing_secret_enc" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	CONSTRAINT "plugins_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ALTER COLUMN "scopes" SET DEFAULT '["*"]'::jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "story_points" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_filter_id_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_subscriptions" ADD CONSTRAINT "filter_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_deliveries" ADD CONSTRAINT "plugin_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_settings" ADD CONSTRAINT "plugin_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "filter_subscriptions_filter_user_uniq" ON "filter_subscriptions" USING btree ("filter_id","user_id");--> statement-breakpoint
CREATE INDEX "filter_subscriptions_user_id_idx" ON "filter_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plugin_deliveries_plugin_created_idx" ON "plugin_deliveries" USING btree ("plugin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_settings_plugin_key_uniq" ON "plugin_settings" USING btree ("plugin_id","key");