CREATE TABLE "issue_security_level_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"level_id" integer NOT NULL,
	"member_type" varchar(20) NOT NULL,
	"user_id" integer,
	"group_id" integer,
	"project_role_id" integer
);
--> statement-breakpoint
CREATE TABLE "issue_security_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"scheme_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_security_scheme_associations" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"scheme_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_security_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"default_level_id" integer
);
--> statement-breakpoint
CREATE TABLE "ldap_directories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"url" varchar(500) NOT NULL,
	"start_tls" boolean DEFAULT false NOT NULL,
	"tls_reject_unauthorized" boolean DEFAULT true NOT NULL,
	"bind_dn" varchar(1000) NOT NULL,
	"bind_password_encrypted" text NOT NULL,
	"base_dn" varchar(1000) NOT NULL,
	"user_filter" varchar(1000) DEFAULT '(objectClass=person)' NOT NULL,
	"username_attribute" varchar(100) DEFAULT 'uid' NOT NULL,
	"email_attribute" varchar(100) DEFAULT 'mail' NOT NULL,
	"display_name_attribute" varchar(100) DEFAULT 'cn' NOT NULL,
	"unique_id_attribute" varchar(100) DEFAULT 'entryUUID' NOT NULL,
	"group_base_dn" varchar(1000),
	"group_filter" varchar(1000) DEFAULT '(objectClass=groupOfNames)' NOT NULL,
	"group_name_attribute" varchar(100) DEFAULT 'cn' NOT NULL,
	"group_member_attribute" varchar(100) DEFAULT 'member' NOT NULL,
	"nested_groups" boolean DEFAULT false NOT NULL,
	"login_enabled" boolean DEFAULT true NOT NULL,
	"auto_provision" boolean DEFAULT false NOT NULL,
	"link_by_email" boolean DEFAULT false NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"sync_interval_minutes" integer DEFAULT 360 NOT NULL,
	"deactivate_missing" boolean DEFAULT true NOT NULL,
	"max_entries" integer DEFAULT 10000 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_result" jsonb,
	"sync_lock_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(40) NOT NULL,
	"idp_entity_id" varchar(500) NOT NULL,
	"idp_sso_url" varchar(1000) NOT NULL,
	"idp_certificates" text NOT NULL,
	"sign_requests" boolean DEFAULT false NOT NULL,
	"sp_signing_key_encrypted" text,
	"sp_signing_certificate" text,
	"name_id_format" varchar(200) DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	"email_attribute" varchar(300),
	"display_name_attribute" varchar(300),
	"username_attribute" varchar(300),
	"groups_attribute" varchar(300),
	"sync_groups" boolean DEFAULT false NOT NULL,
	"default_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_provision" boolean DEFAULT false NOT NULL,
	"link_by_email" boolean DEFAULT false NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saml_providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "security_level_id" integer;--> statement-breakpoint
ALTER TABLE "screen_tab_fields" ADD COLUMN "field_key" varchar(50);--> statement-breakpoint
ALTER TABLE "screen_tab_fields" ADD COLUMN "required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_security_level_members" ADD CONSTRAINT "issue_security_level_members_level_id_issue_security_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."issue_security_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_level_members" ADD CONSTRAINT "issue_security_level_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_level_members" ADD CONSTRAINT "issue_security_level_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_level_members" ADD CONSTRAINT "issue_security_level_members_project_role_id_project_roles_id_fk" FOREIGN KEY ("project_role_id") REFERENCES "public"."project_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_levels" ADD CONSTRAINT "issue_security_levels_scheme_id_issue_security_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."issue_security_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_scheme_associations" ADD CONSTRAINT "issue_security_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_security_scheme_associations" ADD CONSTRAINT "issue_security_scheme_associations_scheme_id_issue_security_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."issue_security_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_security_level_members_level_idx" ON "issue_security_level_members" USING btree ("level_id");--> statement-breakpoint
CREATE INDEX "issue_security_levels_scheme_idx" ON "issue_security_levels" USING btree ("scheme_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_security_level_id_issue_security_levels_id_fk" FOREIGN KEY ("security_level_id") REFERENCES "public"."issue_security_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing permission schemes: whoever holds PROJECT_ADMIN also gets SET_ISSUE_SECURITY (same convention as the default scheme).
INSERT INTO "permission_entries" ("scheme_id", "permission_key", "user_id", "group_id", "project_role_id", "any_user", "anonymous")
SELECT e."scheme_id", 'SET_ISSUE_SECURITY', e."user_id", e."group_id", e."project_role_id", e."any_user", false
FROM "permission_entries" e
WHERE e."permission_key" = 'PROJECT_ADMIN' AND COALESCE(e."anonymous", false) = false
  AND NOT EXISTS (SELECT 1 FROM "permission_entries" x WHERE x."scheme_id" = e."scheme_id" AND x."permission_key" = 'SET_ISSUE_SECURITY');