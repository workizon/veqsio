ALTER TABLE "custom_field_options" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD COLUMN "color" varchar(7);--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;