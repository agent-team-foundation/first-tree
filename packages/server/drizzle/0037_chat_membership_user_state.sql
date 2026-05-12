-- Chat data model restructure — Step 2 (migration N).
-- See proposals/chat-data-model-restructure.20260512.md §8 (schema)
-- and §9 (migration path).
--
-- Replaces the chat_participants / chat_subscriptions split with a
-- three-layer model: chats (entity) + chat_membership (structure) +
-- chat_user_state (per-user private state). This migration creates
-- the two new tables and back-fills them from the legacy two; the
-- legacy tables stay in place. A follow-up migration (0038, separate
-- PR) drops them once the new code stabilises ≥1 workday in prod —
-- see §9.2 step 6 for why those are split.
--
-- Pre-flight collision probe (§9.1) MUST be run against staging and
-- prod read-replicas before this PR is opened. If
--   SELECT chat_id, agent_id
--     FROM chat_participants p JOIN chat_subscriptions s USING (chat_id, agent_id)
-- returns any rows, the cutover preference (speaker row wins) applies
-- automatically via the insert ordering below, but the surprise should
-- be investigated first.
--
-- Service-layer integrity (no FK / CHECK / trigger): consistent with
-- messages / inbox_entries / notifications. The DB-level
-- `ON DELETE CASCADE` from chats.id is intentionally NOT carried over
-- — chat hard-delete paths must explicitly clean these tables (see
-- §8.5, §11.7 chat-delete integration test).
--
-- Migration 0037 is hand-written. drizzle-kit generate refuses to
-- diff against the pre-0019 snapshot; we have followed this convention
-- for every migration since 0019 (see 0036's header).

CREATE TABLE IF NOT EXISTS "chat_membership" (
  "chat_id"     text NOT NULL,
  "agent_id"    text NOT NULL,
  "role"        text NOT NULL DEFAULT 'member',
  "access_mode" text NOT NULL,
  "mode"        text NOT NULL DEFAULT 'full',
  "source"      text NOT NULL DEFAULT 'manual',
  "joined_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chat_membership_pkey" PRIMARY KEY ("chat_id", "agent_id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_membership_agent"
  ON "chat_membership" ("agent_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_membership_chat_access"
  ON "chat_membership" ("chat_id", "access_mode");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_user_state" (
  "chat_id"              text NOT NULL,
  "agent_id"             text NOT NULL,
  "last_read_at"         timestamp with time zone,
  "unread_mention_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "chat_user_state_pkey" PRIMARY KEY ("chat_id", "agent_id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_agent"
  ON "chat_user_state" ("agent_id");

--> statement-breakpoint
-- Partial index for the unread-badge / ?filter=unread lookup. Most rows
-- have unread_mention_count = 0; bounding the index by the actual
-- unread row count keeps the scan cheap regardless of table size.
CREATE INDEX IF NOT EXISTS "idx_user_state_unread"
  ON "chat_user_state" ("agent_id")
  WHERE unread_mention_count > 0;

--> statement-breakpoint
-- Back-fill chat_membership from chat_participants. These are the
-- "speaker" rows — they retain their owner/member role from the legacy
-- table and gain access_mode = 'speaker'. `joined_at` carries over
-- verbatim. `source = 'manual'` is the conservative default; we do not
-- attempt to reconstruct the original add-path retroactively.
INSERT INTO "chat_membership"
  ("chat_id", "agent_id", "role", "access_mode", "mode", "source", "joined_at")
SELECT
  cp."chat_id",
  cp."agent_id",
  COALESCE(cp."role", 'member'),
  'speaker',
  COALESCE(cp."mode", 'full'),
  'manual',
  COALESCE(cp."joined_at", now())
FROM "chat_participants" cp
ON CONFLICT ("chat_id", "agent_id") DO NOTHING;

--> statement-breakpoint
-- Back-fill chat_membership from chat_subscriptions. These are the
-- "watcher" rows. ON CONFLICT DO NOTHING means: if a row was already
-- inserted from chat_participants for the same (chat, agent) pair (an
-- invariant-1 violation — see §9.1), the speaker row wins. This is the
-- explicit merge policy from proposal §9.2 step 3.
--
-- source = 'auto_manager' captures that watcher rows historically came
-- from recomputeChatWatchers' anchor-based set rebuild. This default is
-- harmless even for the rare manually-attached watcher rows.
INSERT INTO "chat_membership"
  ("chat_id", "agent_id", "role", "access_mode", "mode", "source", "joined_at")
SELECT
  cs."chat_id",
  cs."agent_id",
  'member',
  'watcher',
  'full',
  'auto_manager',
  COALESCE(cs."created_at", now())
FROM "chat_subscriptions" cs
ON CONFLICT ("chat_id", "agent_id") DO NOTHING;

--> statement-breakpoint
-- Back-fill chat_user_state from chat_participants. Only rows whose
-- read state was actually touched (lastReadAt non-null OR
-- unreadMentionCount > 0) are materialised — the rest can be served
-- via COALESCE-defaults at read time and would only bloat the table.
INSERT INTO "chat_user_state"
  ("chat_id", "agent_id", "last_read_at", "unread_mention_count")
SELECT
  cp."chat_id",
  cp."agent_id",
  cp."last_read_at",
  cp."unread_mention_count"
FROM "chat_participants" cp
WHERE cp."last_read_at" IS NOT NULL
   OR cp."unread_mention_count" > 0
ON CONFLICT ("chat_id", "agent_id") DO NOTHING;

--> statement-breakpoint
-- Same back-fill from chat_subscriptions, with the same speaker-wins
-- merge policy (ON CONFLICT DO NOTHING — chat_participants got there
-- first).
INSERT INTO "chat_user_state"
  ("chat_id", "agent_id", "last_read_at", "unread_mention_count")
SELECT
  cs."chat_id",
  cs."agent_id",
  cs."last_read_at",
  cs."unread_mention_count"
FROM "chat_subscriptions" cs
WHERE cs."last_read_at" IS NOT NULL
   OR cs."unread_mention_count" > 0
ON CONFLICT ("chat_id", "agent_id") DO NOTHING;

--> statement-breakpoint
-- Row-count assertions. Fail the migration loudly if the back-fills
-- did not materialise the expected number of rows. UNION (deduping by
-- (chat_id, agent_id)) matches the speaker-wins merge policy above.
DO $$
DECLARE
  expected_membership int;
  actual_membership   int;
  expected_state      int;
  actual_state        int;
BEGIN
  SELECT COUNT(*) INTO expected_membership FROM (
    SELECT "chat_id", "agent_id" FROM "chat_participants"
    UNION
    SELECT "chat_id", "agent_id" FROM "chat_subscriptions"
  ) sub;

  SELECT COUNT(*) INTO actual_membership FROM "chat_membership";

  IF expected_membership <> actual_membership THEN
    RAISE EXCEPTION 'chat_membership row count mismatch: expected % got %',
      expected_membership, actual_membership;
  END IF;

  SELECT COUNT(*) INTO expected_state FROM (
    SELECT "chat_id", "agent_id" FROM "chat_participants"
     WHERE "last_read_at" IS NOT NULL OR "unread_mention_count" > 0
    UNION
    SELECT "chat_id", "agent_id" FROM "chat_subscriptions"
     WHERE "last_read_at" IS NOT NULL OR "unread_mention_count" > 0
  ) sub;

  SELECT COUNT(*) INTO actual_state FROM "chat_user_state";

  IF expected_state <> actual_state THEN
    RAISE EXCEPTION 'chat_user_state row count mismatch: expected % got %',
      expected_state, actual_state;
  END IF;
END $$;
