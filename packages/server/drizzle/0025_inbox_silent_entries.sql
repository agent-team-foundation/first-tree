-- Silent inbox entries for missed group-chat context.
--
-- Adds `inbox_entries.notify`, defaulting to true so existing rows continue to
-- behave as "active" deliverables. Group-chat fan-out now writes a row for
-- every non-sender participant — for `mention_only` participants who aren't
-- explicitly @mentioned in the triggering message we set `notify = false` so
-- the row is silently parked. Subsequent active deliveries to the same chat
-- pick up these silent rows and replay them as preceding context, then
-- bulk-ack them so they don't get re-replayed.
--
-- See proposals/group-chat-ux-improvements §1 (silent inbox).
--
-- ──────────────── Indexes ────────────────
--
--   idx_inbox_pending_notify — partial index used by pollInbox's claim.
--     The query is "WHERE inbox_id = ? AND status = 'pending' AND notify = true
--     ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED". Without `notify` in
--     the index, a chat that accumulates silent rows (mention_only agent in a
--     chatty group) forces the planner to scan past them before finding the
--     next trigger. Partial index keeps it bounded.
--
--   idx_inbox_chat_silent — used by collectPrecedingContext to walk the
--     silent rows in a single (inbox, chat) bucket between two triggers.
--
-- ──────────────── Operator note ────────────────
--
-- Drizzle migrator wraps every migration file in a single transaction (see the
-- comment block in 0020_unified_user_token.sql), which means we can't use
-- `CREATE INDEX CONCURRENTLY` here — PG rejects it inside a tx. On a small
-- `inbox_entries` table the regular `CREATE INDEX` finishes in <1s and is
-- fine. For a large production table, the runbook is:
--
--   1. Stop applying new migrations briefly.
--   2. Manually run, OUTSIDE a transaction:
--        CREATE INDEX CONCURRENTLY idx_inbox_pending_notify
--          ON inbox_entries (inbox_id, created_at)
--          WHERE status = 'pending' AND notify = true;
--        CREATE INDEX CONCURRENTLY idx_inbox_chat_silent
--          ON inbox_entries (inbox_id, chat_id, notify, status);
--   3. Re-run `pnpm db:migrate`. The `IF NOT EXISTS` clauses below detect
--      the pre-created indexes and skip them.

ALTER TABLE "inbox_entries"
	ADD COLUMN "notify" boolean DEFAULT true NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_pending_notify"
	ON "inbox_entries" ("inbox_id", "created_at")
	WHERE status = 'pending' AND notify = true;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_chat_silent"
	ON "inbox_entries" ("inbox_id", "chat_id", "notify", "status");
