CREATE TABLE "installed_modules" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"version" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "module_migrations" (
	"module_id" varchar(40) NOT NULL,
	"name" varchar(100) NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_migrations_module_id_name_pk" PRIMARY KEY("module_id","name")
);
--> statement-breakpoint
ALTER TABLE "installed_modules" ADD CONSTRAINT "installed_modules_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;