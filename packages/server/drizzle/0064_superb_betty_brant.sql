-- Delivery-status lookup index for chat message history.
--
-- The messages list API derives deliveryStatus from inbox_entries by
-- checking rows for each page message. Keeping message_id first lets the
-- acked / delivered / any-entry probes use one bounded lookup instead of
-- scanning the full inbox_entries table.
--
-- Operator note:
-- Drizzle migrator executes migration files inside a transaction, so this file
-- cannot use CREATE INDEX CONCURRENTLY. For a large production table, run the
-- concurrent form manually outside a transaction before applying migrations:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_inbox_entries_message_status"
--     ON "inbox_entries" ("message_id", "status");
--
-- The IF NOT EXISTS clause below will then skip the already-created index.
CREATE INDEX IF NOT EXISTS "idx_inbox_entries_message_status"
  ON "inbox_entries" USING btree ("message_id", "status");
