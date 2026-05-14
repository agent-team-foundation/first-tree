-- Add inline avatar image storage to agents.
--
-- The PRD chose PG bytea over object storage for the first cut: clients
-- always pre-resize to 256×256 WEBP (typically < 50 KB), and a few KB ×
-- N agents per org sits well within row-size budgets. Switching to S3/R2
-- later is a follow-up migration; the column shape stays the same except
-- avatar_image_data flips to NULL and avatar_image_url moves to a real
-- external URL.
--
-- All three columns are nullable and move together — either all three
-- carry an image (data + mime + updated_at) or all are NULL. The service
-- layer enforces that invariant on writes; SQL keeps it loose so a partial
-- backfill / restore doesn't break inserts.
ALTER TABLE "agents"
  ADD COLUMN "avatar_image_data" bytea,
  ADD COLUMN "avatar_image_mime" text,
  ADD COLUMN "avatar_image_updated_at" timestamp with time zone;
