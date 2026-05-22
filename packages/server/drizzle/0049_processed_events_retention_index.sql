-- Retention support for `processed_events` (webhook dedup ledger used by
-- GitHub App + Feishu). Rows accumulate at every webhook delivery and
-- were previously never deleted — at realistic load the table would grow
-- by ~1M rows / year. The dedup ledger is only meaningful for as long as
-- a redelivery could still arrive (GitHub retries ~8h, Feishu similar),
-- so 30-day retention is overkill-safe.
--
-- Cleanup is a background DELETE driven by
-- `services/adapter-mapping.ts::pruneProcessedEvents`. Without this btree
-- on `created_at` the DELETE WHERE created_at < threshold would scan the
-- whole table on every tick; with it the cleanup stays a bounded
-- operation. See #509.
CREATE INDEX IF NOT EXISTS "idx_processed_events_created_at"
  ON "processed_events" USING btree ("created_at");
