-- Replace the chat-silent composite with two partial indexes keyed on `id`.
--
-- Preceding-context assembly now runs as one set-based statement instead of
-- one query per claimed trigger. Inside the LATERAL, each trigger's window
-- bounds (`> previous notify cursor`, `< trigger`) are correlated values, so
-- the planner cannot estimate their width. Without `id` in the index it scans
-- every silent row in the chat and discards almost all of them.
--
--   idx_inbox_chat_silent_pending — the silent rows a trigger bundles as
--     preceding context, and ACK-through's silent drain.
--
--   idx_inbox_chat_notify — the previous-trigger cursor and ACK-through's
--     contiguous notify prefix. Deliberately not filtered on `status`: an
--     already-acked trigger still closes a preceding-context window, and the
--     prefix check has to walk acked rows to prove there is no gap.
--
-- Partial rather than appending `status`/`notify` to the key: a key ending in
-- the unique `id` defeats B-tree deduplication. Measured on 240k rows, the old
-- four-column form costs ~7 bytes per row because near-duplicate keys compress;
-- appending `id` makes every key unique and costs ~49 bytes per row (1.7 MB ->
-- 11 MB). Restricting the row set keeps the pair at ~2.6 MB, and since
-- `inbox_entries` is append-only, excluding consumed rows matters more as the
-- table grows.
--
-- Operator note:
-- Drizzle migrator executes migration files inside a transaction, so this file
-- cannot use CREATE INDEX CONCURRENTLY. A plain CREATE INDEX takes a SHARE lock
-- and DROP INDEX takes ACCESS EXCLUSIVE; on a large `inbox_entries` — which
-- sits in the message delivery hot path — that is a visible write stall. For a
-- large production table, run the concurrent forms manually outside a
-- transaction before applying migrations, creating the new indexes BEFORE
-- dropping the old one so no lookup is ever left unindexed:
--
--   1. CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_inbox_chat_silent_pending"
--        ON "inbox_entries" ("inbox_id", "chat_id", "id")
--        WHERE status = 'pending' AND notify = false;
--   2. CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_inbox_chat_notify"
--        ON "inbox_entries" ("inbox_id", "chat_id", "id")
--        WHERE notify = true;
--   3. Verify both are valid (indisvalid in pg_index) and being used, then:
--        DROP INDEX CONCURRENTLY IF EXISTS "idx_inbox_chat_silent";
--   4. Re-run `pnpm db:migrate`. The IF NOT EXISTS / IF EXISTS clauses below
--      detect the manual work and skip it.
--
-- The new indexes carry different names from the one being dropped precisely so
-- this ordering is possible; reusing `idx_inbox_chat_silent` would force a
-- window with no index backing the silent-row lookup.
CREATE INDEX IF NOT EXISTS "idx_inbox_chat_silent_pending"
  ON "inbox_entries" USING btree ("inbox_id","chat_id","id")
  WHERE status = 'pending' AND notify = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_chat_notify"
  ON "inbox_entries" USING btree ("inbox_id","chat_id","id")
  WHERE notify = true;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inbox_chat_silent";
