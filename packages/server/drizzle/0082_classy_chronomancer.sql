-- Custom SQL migration (drizzle-kit generate --custom).
--
-- Why custom: `processed_events` predates the drizzle schema index and is
-- not tracked in the drizzle snapshot chain (it was created in
-- 0003_feishu_adapter.sql and is intentionally not exported from
-- src/db/schema/index.ts), so `drizzle-kit generate` cannot diff-emit the
-- ALTERs. This file applies the claim-lifecycle columns for issue #317:
--
--   - existing rows represent events that already completed processing
--     (they received a 200), so they backfill to 'done' and keep deduping;
--   - new claims always set status explicitly; 'pending' is the fail-safe
--     default direction (an unforeseen insert stays re-processable, never
--     silently deduped);
--   - `expires_at` is set only on live 'pending' claims (claim time + TTL).
ALTER TABLE "processed_events" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "processed_events" SET "status" = 'done';--> statement-breakpoint
ALTER TABLE "processed_events" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ALTER COLUMN "status" SET DEFAULT 'pending';
