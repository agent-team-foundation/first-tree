-- Per-(chat, user) engagement state on `chat_user_state`.
-- Replaces the design of closed PR #316, which originally tried to add
-- this column to both `chat_participants` and `chat_subscriptions` and
-- was rejected for forcing double-writes + state-carry across the
-- speaker/watcher boundary. After the data-model restructure
-- (proposals/chat-data-model-restructure.20260512.md, migrations
-- 0038/0039), the natural home is `chat_user_state` — sitting next to
-- the other per-user private columns (`last_read_at`,
-- `unread_mention_count`).
--
-- Values: 'active' (default) | 'archived' | 'deleted'. Auto-revive
-- archived → active happens on new message in `applyAfterFanOut`;
-- `deleted` is sticky and reachable only via the chat detail page +
-- Restore button.
--
-- `chat_user_state` rows are lazy-materialised (row only created on
-- first markRead / mention / engagement write). The service layer
-- reads via `COALESCE(engagement_status, 'active')`, so existing rows
-- without an explicit value (and rows that don't yet exist) both
-- resolve to `'active'` — no back-fill needed and the NOT NULL DEFAULT
-- handles new INSERTs.

ALTER TABLE "chat_user_state"
  ADD COLUMN "engagement_status" text NOT NULL DEFAULT 'active';
