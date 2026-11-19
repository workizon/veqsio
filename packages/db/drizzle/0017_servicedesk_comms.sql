CREATE TABLE "sd_outbound_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_desk_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"message_id" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "reply_address" varchar(320);--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_host" varchar(255);--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_port" integer DEFAULT 993 NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_tls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_user" varchar(320);--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_folder" varchar(255) DEFAULT 'INBOX' NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_poll_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_last_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_last_status" varchar(20);--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_last_error" text;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_last_count" integer;--> statement-breakpoint
ALTER TABLE "sd_email_channels" ADD COLUMN "imap_lock_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_desks" ADD COLUMN "notify_customer_comments" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service_desks" ADD COLUMN "notify_customer_status" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sd_outbound_messages" ADD CONSTRAINT "sd_outbound_messages_service_desk_id_service_desks_id_fk" FOREIGN KEY ("service_desk_id") REFERENCES "public"."service_desks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sd_outbound_messages" ADD CONSTRAINT "sd_outbound_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sd_outbound_messages_uniq" ON "sd_outbound_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "sd_outbound_messages_issue_idx" ON "sd_outbound_messages" USING btree ("issue_id");