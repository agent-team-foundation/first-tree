-- Custom migration (drizzle-kit generate --custom).
--
-- `processed_events` predates drizzle-kit management: it was created by the
-- hand-written 0003_feishu_adapter.sql and is intentionally absent from the
-- drizzle schema snapshot (like the adapter_* tables), so a regular
-- `drizzle-kit generate` cannot emit ALTERs for it. The declarative shape
-- lives in src/db/schema/processed-events.ts for documentation parity.
--
-- Claim lifecycle for webhook event dedup (issue #317): rows gain a
-- pending/done status plus an expiry for pending claims. Existing rows are
-- backfilled to 'done' by the column default so they keep deduping.
ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_processed_events_status_expires" ON "processed_events" ("status","expires_at");
