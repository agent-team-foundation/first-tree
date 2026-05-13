-- DB-backed deduplication for the notifications table.
--
-- Before this migration, the server kept an in-memory Map keyed by
-- `(agentId, notificationType)` to suppress duplicate notifications within a
-- five-minute window. That broke in two important ways:
--
--   1. Multi-instance deployments: each server process owned its own Map, so
--      a notification produced on instance A passed instance B's dedupe gate
--      unchanged. Operators saw the same row inserted multiple times during
--      load-balancer failover or rolling restart.
--   2. Process restart wiped the Map, re-opening the dedupe window for
--      whatever events had fired just before.
--
-- The new model is purely DB-driven. A producer optionally supplies a
-- `dedup_key` (e.g. `agent:{uuid}:error`, `chat:{uuid}:completed`). The
-- partial unique index below scopes uniqueness to `(organization_id,
-- dedup_key)` *while the prior row is still unread*. Re-emitting the same
-- key while the previous notification sits unread is a no-op (the
-- application uses `ON CONFLICT DO NOTHING`); after the user acknowledges
-- the prior row, a fresh notification can land again.
--
-- Producers without a `dedup_key` keep the legacy always-insert behaviour,
-- so this column is purely additive — no back-fill, no NOT NULL constraint.

ALTER TABLE "notifications" ADD COLUMN "dedup_key" text;

CREATE UNIQUE INDEX "uq_notifications_org_dedup_unread"
  ON "notifications" ("organization_id", "dedup_key")
  WHERE read = false AND dedup_key IS NOT NULL;
