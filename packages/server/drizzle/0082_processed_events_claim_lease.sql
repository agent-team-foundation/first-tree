-- Webhook claim lease for `processed_events` (issue #317).
--
-- Turns the at-most-once dedupe marker into a recoverable pending/done
-- lease: deliveries are claimed `pending` with an expiry before processing
-- and flipped to `done` after their side effects landed. A redelivery of an
-- expired `pending` claim takes it over instead of being deduped, so a crash
-- between claim and completion no longer loses the event permanently.
--
-- Custom migration (0046/0053 precedent): `processed_events` predates
-- drizzle-kit management — it was created by 0003 and is deliberately not
-- exported from `src/db/schema/index.ts`, so it is absent from the drizzle
-- snapshots and `drizzle-kit generate` cannot diff column changes for it.
--
-- Backward compatible by construction: no backfill — the `done` default
-- makes every pre-existing row equivalent to "fully processed", preserving
-- the permanent-dedupe semantics for historical deliveries. Old replicas
-- that still insert only (event_id, platform) during a rolling deploy also
-- hit the default and record a terminal `done` row, which is correct.
ALTER TABLE "processed_events" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "claim_token" text;--> statement-breakpoint
-- Pending rows are near-zero in steady state (only live or crashed claims),
-- so this partial index stays tiny; it serves the hygiene sweep and ops
-- queries over stuck claims.
CREATE INDEX "idx_processed_events_pending" ON "processed_events" USING btree ("expires_at") WHERE "processed_events"."status" = 'pending';
