CREATE TABLE "customer_issue_links" (
	"customer_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_issue_links_customer_id_issue_id_pk" PRIMARY KEY("customer_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"importance" smallint DEFAULT 3 NOT NULL,
	"annual_revenue" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_issue_links" ADD CONSTRAINT "customer_issue_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issue_links" ADD CONSTRAINT "customer_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_issue_links" ADD CONSTRAINT "customer_issue_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_issue_links_issue_idx" ON "customer_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_name_uniq" ON "customers" USING btree (lower("name"));