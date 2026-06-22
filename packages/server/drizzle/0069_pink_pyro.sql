ALTER TABLE "chats" ADD COLUMN "description_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "description_updated_by" text;