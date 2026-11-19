CREATE TABLE "application_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"base_url" varchar(500) NOT NULL,
	"display_url" varchar(500),
	"auth_type" varchar(20) DEFAULT 'none' NOT NULL,
	"credentials" jsonb DEFAULT '{}',
	"config" jsonb DEFAULT '{}',
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"filename" varchar(255) NOT NULL,
	"filesize" bigint NOT NULL,
	"mimetype" varchar(100) NOT NULL,
	"storage_key" text NOT NULL,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" integer,
	"actor_name" varchar(255),
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target" varchar(255),
	"method" varchar(10),
	"path" varchar(500),
	"status" integer,
	"ip" varchar(64),
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"config" jsonb DEFAULT '{}',
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_conditions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"condition_type" varchar(50) NOT NULL,
	"operator" varchar(10) DEFAULT 'AND' NOT NULL,
	"config" jsonb DEFAULT '{}',
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"triggered_by" varchar(50) NOT NULL,
	"trigger_issue_key" varchar(50),
	"status" varchar(20) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb DEFAULT '{}',
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"project_id" integer,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"trigger_type" varchar(50) NOT NULL,
	"config" jsonb DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" serial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"status_id" integer,
	"name" varchar(100) NOT NULL,
	"min" integer,
	"max" integer,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "board_quick_filters" (
	"id" serial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"jql" text NOT NULL,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"project_id" integer NOT NULL,
	"filter_id" integer,
	"config" jsonb DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"body" text NOT NULL,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"is_internal" boolean DEFAULT false,
	"parent_comment_id" integer
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"lead_id" integer
);
--> statement-breakpoint
CREATE TABLE "custom_field_contexts" (
	"id" serial PRIMARY KEY NOT NULL,
	"custom_field_id" integer NOT NULL,
	"project_id" integer,
	"issue_type_id" integer
);
--> statement-breakpoint
CREATE TABLE "custom_field_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"custom_field_id" integer NOT NULL,
	"context_id" integer NOT NULL,
	"value" varchar(255) NOT NULL,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"custom_field_id" integer NOT NULL,
	"string_value" varchar(500),
	"number_value" numeric,
	"date_value" timestamp with time zone,
	"user_value" integer,
	"text_value" text,
	"boolean_value" boolean
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"field_type" varchar(50) NOT NULL,
	"description" text,
	"default_value" text,
	"searcher_key" varchar(100),
	"is_global" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "customer_organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_gadgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"dashboard_id" integer NOT NULL,
	"gadget_type" varchar(50) NOT NULL,
	"column_index" integer DEFAULT 0,
	"row_index" integer DEFAULT 0,
	"config" jsonb DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_id" integer,
	"shares" jsonb DEFAULT '[]',
	"layout" varchar(20) DEFAULT '2-column',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dev_branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_link_id" integer NOT NULL,
	"issue_key" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false,
	"ahead_by" integer DEFAULT 0,
	"behind_by" integer DEFAULT 0,
	"last_commit_at" timestamp with time zone,
	"url" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dev_commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_link_id" integer NOT NULL,
	"issue_key" varchar(50) NOT NULL,
	"commit_id" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"author_name" varchar(255),
	"author_email" varchar(255),
	"url" varchar(500),
	"branch" varchar(255),
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dev_pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_link_id" integer NOT NULL,
	"issue_key" varchar(50) NOT NULL,
	"pr_id" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"author_name" varchar(255),
	"status" varchar(20) NOT NULL,
	"source_branch" varchar(255),
	"target_branch" varchar(255),
	"url" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"to_address" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "field_configuration_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"config_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"is_custom_field" boolean DEFAULT false,
	"is_visible" boolean DEFAULT true,
	"is_required" boolean DEFAULT false,
	"renderer" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "field_configuration_scheme_associations" (
	"project_id" integer NOT NULL,
	"issue_type_id" integer NOT NULL,
	"config_id" integer NOT NULL,
	CONSTRAINT "field_configuration_scheme_associations_project_id_issue_type_id_pk" PRIMARY KEY("project_id","issue_type_id")
);
--> statement-breakpoint
CREATE TABLE "field_configurations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "filters" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"jql" text NOT NULL,
	"author_id" integer,
	"favourite" boolean DEFAULT false,
	"shares" jsonb DEFAULT '[]',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	CONSTRAINT "groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "issue_affects_versions" (
	"issue_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	CONSTRAINT "issue_affects_versions_issue_id_version_id_pk" PRIMARY KEY("issue_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "issue_components" (
	"issue_id" integer NOT NULL,
	"component_id" integer NOT NULL,
	CONSTRAINT "issue_components_issue_id_component_id_pk" PRIMARY KEY("issue_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "issue_fix_versions" (
	"issue_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	CONSTRAINT "issue_fix_versions_issue_id_version_id_pk" PRIMARY KEY("issue_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "issue_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"field_name" varchar(100) NOT NULL,
	"old_value" text,
	"new_value" text,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"issue_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "issue_labels_issue_id_label_id_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"linked_issue_id" integer NOT NULL,
	"link_type_id" integer
);
--> statement-breakpoint
CREATE TABLE "issue_type_scheme_associations" (
	"project_id" integer NOT NULL,
	"scheme_id" integer NOT NULL,
	CONSTRAINT "issue_type_scheme_associations_project_id_pk" PRIMARY KEY("project_id")
);
--> statement-breakpoint
CREATE TABLE "issue_type_scheme_items" (
	"scheme_id" integer NOT NULL,
	"issue_type_id" integer NOT NULL,
	CONSTRAINT "issue_type_scheme_items_scheme_id_issue_type_id_pk" PRIMARY KEY("scheme_id","issue_type_id")
);
--> statement-breakpoint
CREATE TABLE "issue_type_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"default_issue_type_id" integer
);
--> statement-breakpoint
CREATE TABLE "issue_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon_url" text,
	"is_subtask" boolean DEFAULT false,
	"color" varchar(7) DEFAULT '#0052CC'
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_key" varchar(100) NOT NULL,
	"project_id" integer NOT NULL,
	"issue_type_id" integer NOT NULL,
	"status_id" integer NOT NULL,
	"priority_id" integer,
	"resolution_id" integer,
	"summary" varchar(500) NOT NULL,
	"description" text,
	"assignee_id" integer,
	"reporter_id" integer NOT NULL,
	"environment" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone,
	"due_date" timestamp with time zone,
	"parent_id" integer,
	"time_estimate" integer,
	"time_spent" integer,
	CONSTRAINT "issues_issue_key_unique" UNIQUE("issue_key")
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"helpful" integer DEFAULT 0 NOT NULL,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	CONSTRAINT "labels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "link_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"inward" varchar(100) NOT NULL,
	"outward" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"total_entities" integer DEFAULT 0,
	"processed_entities" integer DEFAULT 0,
	"errors" jsonb DEFAULT '[]',
	"backup_path" text NOT NULL,
	"options" jsonb DEFAULT '{}',
	"created_by" integer
);
--> statement-breakpoint
CREATE TABLE "notification_scheme_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"scheme_id" integer NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"notify_assignee" boolean DEFAULT false,
	"notify_reporter" boolean DEFAULT false,
	"notify_watchers" boolean DEFAULT false,
	"notify_project_lead" boolean DEFAULT false,
	"notify_all_admins" boolean DEFAULT false,
	"notify_current_user" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "notification_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"project_id" integer,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "permission_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"scheme_id" integer NOT NULL,
	"permission_key" varchar(100) NOT NULL,
	"user_id" integer,
	"group_id" integer,
	"project_role_id" integer,
	"any_user" boolean DEFAULT false,
	"anonymous" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "permission_scheme_associations" (
	"project_id" integer NOT NULL,
	"scheme_id" integer NOT NULL,
	CONSTRAINT "permission_scheme_associations_project_id_pk" PRIMARY KEY("project_id")
);
--> statement-breakpoint
CREATE TABLE "permission_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"scopes" jsonb DEFAULT '["read","write"]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "priorities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon_url" text,
	"color" varchar(7) DEFAULT '#666666',
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "project_issue_counters" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"current_value" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "project_role_actors" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	"user_id" integer,
	"group_id" integer
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_key" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"lead_id" integer,
	"category" varchar(100),
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "projects_project_key_unique" UNIQUE("project_key")
);
--> statement-breakpoint
CREATE TABLE "request_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"user_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_sla_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"sla_id" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"elapsed_ms" bigint DEFAULT 0 NOT NULL,
	"target_minutes" integer NOT NULL,
	"breached" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_type_settings" (
	"request_type_id" integer PRIMARY KEY NOT NULL,
	"visibility" varchar(20) DEFAULT 'all' NOT NULL,
	"organization_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"help_text" text,
	"icon" varchar(50) DEFAULT 'help-circle',
	"group_name" varchar(100),
	"issue_type_id" integer NOT NULL,
	"default_priority_id" integer,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "screen_tab_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"tab_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"is_custom_field" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "screen_tabs" (
	"id" serial PRIMARY KEY NOT NULL,
	"screen_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "screens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "sd_canned_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sd_email_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"default_request_type_id" integer,
	"allowed_sender_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sd_email_channels_service_desk_id_unique" UNIQUE("service_desk_id")
);
--> statement-breakpoint
CREATE TABLE "sd_inbound_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"message_id" varchar(500) NOT NULL,
	"from_address" varchar(320) NOT NULL,
	"subject" varchar(500),
	"issue_id" integer,
	"status" varchar(20) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_desk_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" varchar(20) DEFAULT 'agent' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_desk_customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_desk_portal_settings" (
	"service_desk_id" integer PRIMARY KEY NOT NULL,
	"portal_title" varchar(255),
	"introduction" text,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logo_url" text,
	"accent_color" varchar(20),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_desks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"welcome_message" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"public_signup" boolean DEFAULT false NOT NULL,
	"business_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_desks_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "service_desks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "service_queues" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"jql" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"service_desk_id" integer NOT NULL,
	"request_type_id" integer,
	"customer_id" integer NOT NULL,
	"channel" varchar(20) DEFAULT 'portal' NOT NULL,
	"field_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"csat_rating" integer,
	"csat_comment" text,
	"csat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requests_issue_id_unique" UNIQUE("issue_id")
);
--> statement-breakpoint
CREATE TABLE "sla_calendar_holidays" (
	"id" serial PRIMARY KEY NOT NULL,
	"calendar_id" integer NOT NULL,
	"date" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_calendars" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(20) DEFAULT 'custom' NOT NULL,
	"time_zone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"working_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"metric" varchar(30) NOT NULL,
	"calendar" varchar(20) DEFAULT '24x7' NOT NULL,
	"pause_status_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"start_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pause_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calendar_id" integer,
	"warning_percent" integer
);
--> statement-breakpoint
CREATE TABLE "sla_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"sla_id" integer NOT NULL,
	"priority_id" integer,
	"target_minutes" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"jql" text,
	"calendar_id" integer
);
--> statement-breakpoint
CREATE TABLE "sprint_issues" (
	"sprint_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	CONSTRAINT "sprint_issues_sprint_id_issue_id_pk" PRIMARY KEY("sprint_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"goal" text,
	"state" varchar(20) DEFAULT 'future',
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"complete_date" timestamp with time zone,
	"board_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(50) DEFAULT 'microsoft' NOT NULL,
	"client_id" varchar(500) NOT NULL,
	"client_secret" varchar(500) NOT NULL,
	"tenant_id" varchar(255) NOT NULL,
	"redirect_uri" varchar(500) NOT NULL,
	"enforce_sso" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"category" varchar(20) NOT NULL,
	"color" varchar(7) DEFAULT '#666666',
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"user_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	CONSTRAINT "user_groups_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_user_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"raw_profile" jsonb DEFAULT '{}',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"active" boolean DEFAULT true,
	"avatar_url" text,
	"timezone" varchar(100) DEFAULT 'UTC',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"start_date" date,
	"release_date" date,
	"released" boolean DEFAULT false,
	"archived" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"issue_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "votes_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "watchers" (
	"issue_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "watchers_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"event" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"response_status" integer,
	"response_body" text,
	"success" boolean DEFAULT false,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"url" text NOT NULL,
	"secret" text,
	"events" jsonb DEFAULT '[]' NOT NULL,
	"active" boolean DEFAULT true,
	"failure_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_scheme_associations" (
	"project_id" integer NOT NULL,
	"scheme_id" integer NOT NULL,
	CONSTRAINT "workflow_scheme_associations_project_id_pk" PRIMARY KEY("project_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_scheme_items" (
	"scheme_id" integer NOT NULL,
	"issue_type_id" integer NOT NULL,
	"workflow_id" integer NOT NULL,
	CONSTRAINT "workflow_scheme_items_scheme_id_issue_type_id_pk" PRIMARY KEY("scheme_id","issue_type_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"from_status_id" integer,
	"to_status_id" integer NOT NULL,
	"screen_id" integer,
	"conditions" jsonb DEFAULT '[]',
	"validators" jsonb DEFAULT '[]',
	"post_functions" jsonb DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false,
	"designer_layout" jsonb DEFAULT '{"nodes":{}}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "worklogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"issue_key" varchar(50) NOT NULL,
	"author_id" integer,
	"author_name" varchar(255),
	"author_email" varchar(255),
	"description" text,
	"time_spent_seconds" integer NOT NULL,
	"started" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_conditions" ADD CONSTRAINT "automation_conditions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_quick_filters" ADD CONSTRAINT "board_quick_filters_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_contexts" ADD CONSTRAINT "custom_field_contexts_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_contexts" ADD CONSTRAINT "custom_field_contexts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_contexts" ADD CONSTRAINT "custom_field_contexts_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_context_id_custom_field_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."custom_field_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_user_value_users_id_fk" FOREIGN KEY ("user_value") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_organizations" ADD CONSTRAINT "customer_organizations_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_gadgets" ADD CONSTRAINT "dashboard_gadgets_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_branches" ADD CONSTRAINT "dev_branches_application_link_id_application_links_id_fk" FOREIGN KEY ("application_link_id") REFERENCES "public"."application_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_commits" ADD CONSTRAINT "dev_commits_application_link_id_application_links_id_fk" FOREIGN KEY ("application_link_id") REFERENCES "public"."application_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_pull_requests" ADD CONSTRAINT "dev_pull_requests_application_link_id_application_links_id_fk" FOREIGN KEY ("application_link_id") REFERENCES "public"."application_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_configuration_items" ADD CONSTRAINT "field_configuration_items_config_id_field_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."field_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_configuration_scheme_associations" ADD CONSTRAINT "field_configuration_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_configuration_scheme_associations" ADD CONSTRAINT "field_configuration_scheme_associations_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_configuration_scheme_associations" ADD CONSTRAINT "field_configuration_scheme_associations_config_id_field_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."field_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filters" ADD CONSTRAINT "filters_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_affects_versions" ADD CONSTRAINT "issue_affects_versions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_affects_versions" ADD CONSTRAINT "issue_affects_versions_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_components" ADD CONSTRAINT "issue_components_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_components" ADD CONSTRAINT "issue_components_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_fix_versions" ADD CONSTRAINT "issue_fix_versions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_fix_versions" ADD CONSTRAINT "issue_fix_versions_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_link_type_id_link_types_id_fk" FOREIGN KEY ("link_type_id") REFERENCES "public"."link_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_type_scheme_associations" ADD CONSTRAINT "issue_type_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_type_scheme_associations" ADD CONSTRAINT "issue_type_scheme_associations_scheme_id_issue_type_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."issue_type_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_type_scheme_items" ADD CONSTRAINT "issue_type_scheme_items_scheme_id_issue_type_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."issue_type_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_type_scheme_items" ADD CONSTRAINT "issue_type_scheme_items_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_type_schemes" ADD CONSTRAINT "issue_type_schemes_default_issue_type_id_issue_types_id_fk" FOREIGN KEY ("default_issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_priority_id_priorities_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."priorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolution_id_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_sessions" ADD CONSTRAINT "migration_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_scheme_events" ADD CONSTRAINT "notification_scheme_events_scheme_id_notification_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."notification_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_schemes" ADD CONSTRAINT "notification_schemes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_entries" ADD CONSTRAINT "permission_entries_scheme_id_permission_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."permission_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_entries" ADD CONSTRAINT "permission_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_entries" ADD CONSTRAINT "permission_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_entries" ADD CONSTRAINT "permission_entries_project_role_id_project_roles_id_fk" FOREIGN KEY ("project_role_id") REFERENCES "public"."project_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scheme_associations" ADD CONSTRAINT "permission_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scheme_associations" ADD CONSTRAINT "permission_scheme_associations_scheme_id_permission_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."permission_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_issue_counters" ADD CONSTRAINT "project_issue_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_actors" ADD CONSTRAINT "project_role_actors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_actors" ADD CONSTRAINT "project_role_actors_role_id_project_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."project_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_actors" ADD CONSTRAINT "project_role_actors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_actors" ADD CONSTRAINT "project_role_actors_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_participants" ADD CONSTRAINT "request_participants_request_id_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_participants" ADD CONSTRAINT "request_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_sla_states" ADD CONSTRAINT "request_sla_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_sla_states" ADD CONSTRAINT "request_sla_states_sla_id_sla_definitions_id_fk" FOREIGN KEY ("sla_id") REFERENCES "public"."sla_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_type_settings" ADD CONSTRAINT "request_type_settings_request_type_id_request_types_id_fk" FOREIGN KEY ("request_type_id") REFERENCES "public"."request_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_default_priority_id_priorities_id_fk" FOREIGN KEY ("default_priority_id") REFERENCES "public"."priorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_tab_fields" ADD CONSTRAINT "screen_tab_fields_tab_id_screen_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."screen_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_tabs" ADD CONSTRAINT "screen_tabs_screen_id_screens_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."screens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_canned_responses" ADD CONSTRAINT "sd_canned_responses_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_canned_responses" ADD CONSTRAINT "sd_canned_responses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD CONSTRAINT "sd_email_channels_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD CONSTRAINT "sd_email_channels_default_request_type_id_request_types_id_fk" FOREIGN KEY ("default_request_type_id") REFERENCES "public"."request_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_inbound_messages" ADD CONSTRAINT "sd_inbound_messages_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_inbound_messages" ADD CONSTRAINT "sd_inbound_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desk_agents" ADD CONSTRAINT "service_desk_agents_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desk_agents" ADD CONSTRAINT "service_desk_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desk_customers" ADD CONSTRAINT "service_desk_customers_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desk_customers" ADD CONSTRAINT "service_desk_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desk_portal_settings" ADD CONSTRAINT "service_desk_portal_settings_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_desks" ADD CONSTRAINT "service_desks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_queues" ADD CONSTRAINT "service_queues_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_request_type_id_request_types_id_fk" FOREIGN KEY ("request_type_id") REFERENCES "public"."request_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_calendar_holidays" ADD CONSTRAINT "sla_calendar_holidays_calendar_id_sla_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."sla_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_calendars" ADD CONSTRAINT "sla_calendars_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_definitions" ADD CONSTRAINT "sla_definitions_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_goals" ADD CONSTRAINT "sla_goals_sla_id_sla_definitions_id_fk" FOREIGN KEY ("sla_id") REFERENCES "public"."sla_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_goals" ADD CONSTRAINT "sla_goals_priority_id_priorities_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."priorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_issues" ADD CONSTRAINT "sprint_issues_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_issues" ADD CONSTRAINT "sprint_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_scheme_associations" ADD CONSTRAINT "workflow_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_scheme_associations" ADD CONSTRAINT "workflow_scheme_associations_scheme_id_workflow_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."workflow_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_scheme_items" ADD CONSTRAINT "workflow_scheme_items_scheme_id_workflow_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."workflow_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_scheme_items" ADD CONSTRAINT "workflow_scheme_items_issue_type_id_issue_types_id_fk" FOREIGN KEY ("issue_type_id") REFERENCES "public"."issue_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_scheme_items" ADD CONSTRAINT "workflow_scheme_items_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_status_id_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_status_id_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_links_type_idx" ON "application_links" USING btree ("type");--> statement-breakpoint
CREATE INDEX "application_links_active_idx" ON "application_links" USING btree ("active");--> statement-breakpoint
CREATE INDEX "attachments_issue_id_idx" ON "attachments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "attachments_author_id_idx" ON "attachments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_name");--> statement-breakpoint
CREATE INDEX "automation_actions_rule_id_idx" ON "automation_actions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "automation_conditions_rule_id_idx" ON "automation_conditions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "automation_executions_rule_id_idx" ON "automation_executions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "automation_executions_status_idx" ON "automation_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_executions_started_at_idx" ON "automation_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "automation_rules_project_id_idx" ON "automation_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_rules_created_by_idx" ON "automation_rules" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "automation_triggers_rule_id_idx" ON "automation_triggers" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "board_columns_board_id_idx" ON "board_columns" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_columns_status_id_idx" ON "board_columns" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "board_quick_filters_board_id_idx" ON "board_quick_filters" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "boards_project_id_idx" ON "boards" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "comments_parent_comment_id_idx" ON "comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "comments_issue_id_idx" ON "comments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "comments_author_id_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "components_project_id_idx" ON "components" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "components_lead_id_idx" ON "components" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "custom_field_contexts_custom_field_id_idx" ON "custom_field_contexts" USING btree ("custom_field_id");--> statement-breakpoint
CREATE INDEX "custom_field_contexts_project_id_idx" ON "custom_field_contexts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "custom_field_contexts_issue_type_id_idx" ON "custom_field_contexts" USING btree ("issue_type_id");--> statement-breakpoint
CREATE INDEX "custom_field_options_custom_field_id_idx" ON "custom_field_options" USING btree ("custom_field_id");--> statement-breakpoint
CREATE INDEX "custom_field_options_context_id_idx" ON "custom_field_options" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_issue_id_idx" ON "custom_field_values" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_custom_field_id_idx" ON "custom_field_values" USING btree ("custom_field_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_user_value_idx" ON "custom_field_values" USING btree ("user_value");--> statement-breakpoint
CREATE INDEX "dashboard_gadgets_dashboard_id_idx" ON "dashboard_gadgets" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboards_owner_id_idx" ON "dashboards" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "dev_branches_issue_key_idx" ON "dev_branches" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "dev_branches_application_link_id_idx" ON "dev_branches" USING btree ("application_link_id");--> statement-breakpoint
CREATE INDEX "dev_commits_issue_key_idx" ON "dev_commits" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "dev_commits_application_link_id_idx" ON "dev_commits" USING btree ("application_link_id");--> statement-breakpoint
CREATE INDEX "dev_commits_commit_id_idx" ON "dev_commits" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "dev_pull_requests_issue_key_idx" ON "dev_pull_requests" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "dev_pull_requests_application_link_id_idx" ON "dev_pull_requests" USING btree ("application_link_id");--> statement-breakpoint
CREATE INDEX "dev_pull_requests_pr_id_idx" ON "dev_pull_requests" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "email_queue_status_idx" ON "email_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_queue_created_at_idx" ON "email_queue" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "field_configuration_items_config_id_idx" ON "field_configuration_items" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "field_configuration_scheme_associations_project_id_idx" ON "field_configuration_scheme_associations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "field_configuration_scheme_associations_config_id_idx" ON "field_configuration_scheme_associations" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "filters_author_id_idx" ON "filters" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "issue_affects_versions_issue_id_idx" ON "issue_affects_versions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_affects_versions_version_id_idx" ON "issue_affects_versions" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "issue_components_issue_id_idx" ON "issue_components" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_components_component_id_idx" ON "issue_components" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "issue_fix_versions_issue_id_idx" ON "issue_fix_versions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_fix_versions_version_id_idx" ON "issue_fix_versions" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "issue_history_issue_id_idx" ON "issue_history" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_history_author_id_idx" ON "issue_history" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "issue_labels_issue_id_idx" ON "issue_labels" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_labels_label_id_idx" ON "issue_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "issue_links_issue_id_idx" ON "issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_links_linked_issue_id_idx" ON "issue_links" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "issue_links_link_type_id_idx" ON "issue_links" USING btree ("link_type_id");--> statement-breakpoint
CREATE INDEX "issue_type_scheme_associations_scheme_id_idx" ON "issue_type_scheme_associations" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "issue_type_scheme_items_scheme_id_idx" ON "issue_type_scheme_items" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "issues_project_id_idx" ON "issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "issues_status_id_idx" ON "issues" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "issues_assignee_id_idx" ON "issues" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "issues_reporter_id_idx" ON "issues" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "issues_issue_type_id_idx" ON "issues" USING btree ("issue_type_id");--> statement-breakpoint
CREATE INDEX "issues_priority_id_idx" ON "issues" USING btree ("priority_id");--> statement-breakpoint
CREATE INDEX "issues_resolution_id_idx" ON "issues" USING btree ("resolution_id");--> statement-breakpoint
CREATE INDEX "issues_parent_id_idx" ON "issues" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "issues_created_at_idx" ON "issues" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "kb_articles_desk_idx" ON "kb_articles" USING btree ("service_desk_id");--> statement-breakpoint
CREATE INDEX "migration_sessions_status_idx" ON "migration_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "migration_sessions_created_by_idx" ON "migration_sessions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "notification_scheme_events_scheme_id_idx" ON "notification_scheme_events" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "notification_scheme_events_event_type_idx" ON "notification_scheme_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "notification_schemes_project_id_idx" ON "notification_schemes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "permission_entries_scheme_id_idx" ON "permission_entries" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "permission_entries_permission_key_idx" ON "permission_entries" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "permission_entries_user_id_idx" ON "permission_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "permission_entries_group_id_idx" ON "permission_entries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "permission_entries_project_role_id_idx" ON "permission_entries" USING btree ("project_role_id");--> statement-breakpoint
CREATE INDEX "permission_scheme_associations_scheme_id_idx" ON "permission_scheme_associations" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_user_id_idx" ON "personal_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_token_hash_idx" ON "personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_role_actors_project_id_idx" ON "project_role_actors" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_role_actors_role_id_idx" ON "project_role_actors" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "project_role_actors_user_id_idx" ON "project_role_actors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_role_actors_group_id_idx" ON "project_role_actors" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "projects_lead_id_idx" ON "projects" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_participants_uniq" ON "request_participants" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_sla_states_uniq" ON "request_sla_states" USING btree ("issue_id","sla_id");--> statement-breakpoint
CREATE INDEX "request_types_desk_idx" ON "request_types" USING btree ("service_desk_id");--> statement-breakpoint
CREATE INDEX "screen_tab_fields_tab_id_idx" ON "screen_tab_fields" USING btree ("tab_id");--> statement-breakpoint
CREATE INDEX "screen_tabs_screen_id_idx" ON "screen_tabs" USING btree ("screen_id");--> statement-breakpoint
CREATE INDEX "sd_canned_responses_desk_idx" ON "sd_canned_responses" USING btree ("service_desk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sd_inbound_messages_uniq" ON "sd_inbound_messages" USING btree ("service_desk_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sd_agents_uniq" ON "service_desk_agents" USING btree ("service_desk_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sd_customers_uniq" ON "service_desk_customers" USING btree ("service_desk_id","user_id");--> statement-breakpoint
CREATE INDEX "service_requests_desk_idx" ON "service_requests" USING btree ("service_desk_id");--> statement-breakpoint
CREATE INDEX "service_requests_customer_idx" ON "service_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sla_calendar_holidays_cal_idx" ON "sla_calendar_holidays" USING btree ("calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_calendars_desk_name_uniq" ON "sla_calendars" USING btree ("service_desk_id","name");--> statement-breakpoint
CREATE INDEX "sprint_issues_sprint_id_idx" ON "sprint_issues" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_issues_issue_id_idx" ON "sprint_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "sprints_board_id_idx" ON "sprints" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "user_groups_user_id_idx" ON "user_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_groups_group_id_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_identities_provider_idx" ON "user_identities" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "user_identities_provider_user_id_idx" ON "user_identities" USING btree ("provider_user_id");--> statement-breakpoint
CREATE INDEX "versions_project_id_idx" ON "versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "votes_issue_id_idx" ON "votes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "votes_user_id_idx" ON "votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "watchers_issue_id_idx" ON "watchers" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "watchers_user_id_idx" ON "watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhooks_project_id_idx" ON "webhooks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "webhooks_active_idx" ON "webhooks" USING btree ("active");--> statement-breakpoint
CREATE INDEX "workflow_scheme_associations_scheme_id_idx" ON "workflow_scheme_associations" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "workflow_scheme_items_scheme_id_idx" ON "workflow_scheme_items" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX "workflow_scheme_items_workflow_id_idx" ON "workflow_scheme_items" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_transitions_workflow_id_idx" ON "workflow_transitions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_transitions_from_status_id_idx" ON "workflow_transitions" USING btree ("from_status_id");--> statement-breakpoint
CREATE INDEX "workflow_transitions_to_status_id_idx" ON "workflow_transitions" USING btree ("to_status_id");--> statement-breakpoint
CREATE INDEX "worklogs_issue_id_idx" ON "worklogs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "worklogs_issue_key_idx" ON "worklogs" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "worklogs_author_id_idx" ON "worklogs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "worklogs_started_idx" ON "worklogs" USING btree ("started");