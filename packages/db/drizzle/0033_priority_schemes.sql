CREATE TABLE "priority_scheme_associations" (
	"project_id" integer NOT NULL,
	"scheme_id" integer NOT NULL,
	CONSTRAINT "priority_scheme_associations_project_id_pk" PRIMARY KEY("project_id")
);
--> statement-breakpoint
CREATE TABLE "priority_scheme_items" (
	"scheme_id" integer NOT NULL,
	"priority_id" integer NOT NULL,
	CONSTRAINT "priority_scheme_items_scheme_id_priority_id_pk" PRIMARY KEY("scheme_id","priority_id")
);
--> statement-breakpoint
CREATE TABLE "priority_schemes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"default_priority_id" integer
);
--> statement-breakpoint
ALTER TABLE "priority_scheme_associations" ADD CONSTRAINT "priority_scheme_associations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_scheme_associations" ADD CONSTRAINT "priority_scheme_associations_scheme_id_priority_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."priority_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_scheme_items" ADD CONSTRAINT "priority_scheme_items_scheme_id_priority_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."priority_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_scheme_items" ADD CONSTRAINT "priority_scheme_items_priority_id_priorities_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."priorities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_schemes" ADD CONSTRAINT "priority_schemes_default_priority_id_priorities_id_fk" FOREIGN KEY ("default_priority_id") REFERENCES "public"."priorities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "priority_scheme_associations_scheme_id_idx" ON "priority_scheme_associations" USING btree ("scheme_id");