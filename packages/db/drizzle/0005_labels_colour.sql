ALTER TABLE "labels" ADD COLUMN "color" varchar(16);--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "remove_on_resolve" boolean DEFAULT false NOT NULL;