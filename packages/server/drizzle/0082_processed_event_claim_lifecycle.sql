ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "processed_events" ADD CONSTRAINT "ck_processed_events_lifecycle" CHECK (("status" = 'pending' AND "expires_at" IS NOT NULL) OR ("status" = 'done' AND "expires_at" IS NULL));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_processed_events_pending_expiry" ON "processed_events" USING btree ("expires_at","id") WHERE "status" = 'pending';
