CREATE TABLE "kb_search_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"term" varchar(200) NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_articles" ADD COLUMN "not_helpful" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_search_log" ADD CONSTRAINT "kb_search_log_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_search_log_desk_time_idx" ON "kb_search_log" USING btree ("service_desk_id","created_at");