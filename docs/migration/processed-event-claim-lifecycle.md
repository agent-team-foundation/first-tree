# Processed-event claim lifecycle migration

Migration `0082_processed_event_claim_lifecycle` adds an expiring `pending` claim and a terminal `done` state to `processed_events`. Existing rows become `done` and retain their current deduplication behavior. The migration is additive, and the existing `(event_id, platform)` uniqueness contract does not change.

## Normal rollout and startup risk

Apply the migration before starting code that writes `pending` claims. The migration runs through Drizzle's transactional migrator. PostgreSQL validates the lifecycle constraint against existing rows, and its partial `(expires_at, id)` index contains only `pending` rows but still scans the existing table while building. Historical `done` retention is currently unbounded, so production tables may be large: the migration can lengthen startup or wait for a conflicting table lock because `CREATE INDEX CONCURRENTLY` cannot run inside its transaction. The optional pre-stage below moves the index build out of startup, but constraint installation still needs its normal migration lock. This migration neither changes nor prunes completed history.

During a forward mixed-version rollout, old webhook workers keep the previous claim-before-work behavior: if one of those workers crashes, its claim can still leak permanently because it cannot write or take over `pending` leases. Drain old workers promptly after the new schema is available; the new recovery contract applies only to deliveries acquired by new workers.

For a large production table, an operator may pre-create the additive columns and index before any instance attempts migration 0082:

```sql
ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'done' NOT NULL;
ALTER TABLE "processed_events" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_processed_events_pending_expiry"
  ON "processed_events" USING btree ("expires_at", "id")
  WHERE "status" = 'pending';
```

Run the concurrent index statement outside a transaction and let it finish before normal migration starts. Do not manually add the lifecycle constraint or modify Drizzle's ledger during this pre-stage. Migration 0082 uses `IF NOT EXISTS` for the columns and index, then installs the constraint and records its own ledger entry. If a concurrent build is interrupted, verify `pg_index.indisvalid`; drop an invalid index before retrying because `IF NOT EXISTS` will not repair it.

## Recovery boundary

A live lease admits one processing winner for its acquisition generation. If an owner runs beyond expiry, a later redelivery may take over while the stale owner has already emitted side effects; the expiry fence prevents stale completion but cannot retract those effects. The contract is therefore not unconditional exactly-once processing after expiry.

GitHub does not automatically redeliver failed webhook deliveries. Expiry makes a later manual or operator-automated redelivery eligible for takeover; the background sweep only removes expired `pending` rows and never stores or replays payloads.

## Ordinary application rollback

An application rollback should leave the additive columns, constraint, index, and migration ledger entry in place. Older code can keep inserting `(event_id, platform)` because omitted lifecycle values default to `done`.

Before old webhook code accepts traffic, stop ingress to **every** new-version webhook handler and wait for all active handlers to drain. Confirm that no process can acquire or complete another `pending` claim, then run the cleanup below. This ordering is mandatory: an old handler interprets any surviving row as a permanent duplicate, and deleting claims while a new handler is still running can admit duplicate business processing. Capture the returned delivery identifiers so orphaned deliveries can be reconciled or redelivered.

<!-- processed-events-rollback-cleanup:start -->
```sql
DELETE FROM "processed_events"
WHERE "status" = 'pending'
RETURNING "event_id", "platform", "created_at", "expires_at";
```
<!-- processed-events-rollback-cleanup:end -->

Deploy the old application only after cleanup completes. Do not drop the lifecycle columns for an ordinary rollback.

## Full schema reversal

Full reversal is exceptional. Quiesce every new-version handler and perform the same pending cleanup first. Reverse 0082 only when it is the newest applied Drizzle migration: the latest `created_at` in `drizzle.__drizzle_migrations` must be `1784645330777`. If a later migration is present, leave 0082 in place or reverse later migrations in their documented order; deleting an older ledger row alone does not make Drizzle reapply it because the migrator compares only the latest timestamp.

Run the following exact block as one operation. It removes only the lifecycle additions and the corresponding ledger row; existing `done` delivery rows and their uniqueness constraint remain intact.

<!-- processed-events-full-reverse:start -->
```sql
BEGIN;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_processed_events_pending_expiry";--> statement-breakpoint
ALTER TABLE "processed_events" DROP CONSTRAINT IF EXISTS "ck_processed_events_lifecycle";--> statement-breakpoint
ALTER TABLE "processed_events" DROP COLUMN IF EXISTS "expires_at";--> statement-breakpoint
ALTER TABLE "processed_events" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1784645330777;--> statement-breakpoint
COMMIT;
```
<!-- processed-events-full-reverse:end -->

Verify that exactly the 0082 ledger row was deleted. A later forward rollout can then run migration 0082 again and recreate the lifecycle schema. Never delete the ledger row while leaving the lifecycle schema reversed only partially.
