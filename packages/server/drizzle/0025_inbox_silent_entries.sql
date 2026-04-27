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

ALTER TABLE "inbox_entries"
	ADD COLUMN "notify" boolean DEFAULT true NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_chat_silent"
	ON "inbox_entries" ("inbox_id", "chat_id", "notify", "status");
