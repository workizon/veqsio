CREATE TABLE "migration_external_refs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(30) NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"external_key" varchar(255),
	"local_id" integer NOT NULL,
	"session_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration_external_refs" ADD CONSTRAINT "migration_external_refs_session_id_migration_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."migration_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_external_refs_uniq" ON "migration_external_refs" USING btree ("source","entity_type","external_id");--> statement-breakpoint
CREATE INDEX "migration_external_refs_local_idx" ON "migration_external_refs" USING btree ("entity_type","local_id");