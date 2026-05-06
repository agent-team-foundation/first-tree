-- Chat-first workspace foundation. See docs/chat-first-workspace-product-design.md
-- for the contract this migration implements.
--
-- Three structural changes + one data backfill:
--   1. chats: add last_message_at + last_message_preview projection columns
--      and (organization_id, last_message_at DESC) index. Powers GET /me/chats
--      cursor pagination + sort.
--   2. chat_participants: add last_read_at + unread_mention_count columns.
--      The chat-first workspace per-user read cursor and red-dot counter
--      live with the participation row that owns them; no separate read-state
--      table.
--   3. chat_subscriptions (NEW): non-speaking observers ("watchers"). Stays
--      strictly disjoint from chat_participants — invariant 1 in the design.
--      ON DELETE CASCADE so dropping a chat tears down its watchers too.
--   4. Backfill (single statement each):
--      - chats projection from messages, using DISTINCT ON to avoid the
--        per-row correlated subquery that would lock messages for minutes
--        on large tables.
--      - chat_subscriptions for every active manager whose managed non-human
--        agent already participates in a chat the manager themselves does
--        not speak in. Exactly the rows recomputeChatWatchers would create
--        on first run, but in one bulk INSERT.
--
-- chat_participants.last_read_at + unread_mention_count default to NULL/0,
-- which is the desired "treat all existing chats as already read" behavior
-- on the workspace upgrade.

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "last_message_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_message_preview" text;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chats_org_last_message"
  ON "chats" ("organization_id", "last_message_at" DESC);

--> statement-breakpoint
ALTER TABLE "chat_participants"
  ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "unread_mention_count" integer NOT NULL DEFAULT 0;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_subscriptions" (
  "chat_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'watching',
  "last_read_at" timestamp with time zone,
  "unread_mention_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chat_subscriptions_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_subscriptions_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("uuid"),
  CONSTRAINT "chat_subscriptions_pkey"
    PRIMARY KEY ("chat_id", "agent_id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_subscriptions_agent"
  ON "chat_subscriptions" ("agent_id");

--> statement-breakpoint
-- Backfill projection: one INSERT-shaped UPDATE driven by a DISTINCT ON
-- subquery so messages is touched once. Avoids the correlated subquery
-- variant that runs two scans per chat row.
WITH last_msg AS (
  SELECT DISTINCT ON ("chat_id")
    "chat_id",
    "created_at",
    LEFT("content"::text, 200) AS "preview"
  FROM "messages"
  ORDER BY "chat_id", "created_at" DESC
)
UPDATE "chats" c
   SET "last_message_at" = lm."created_at",
       "last_message_preview" = lm."preview"
  FROM last_msg lm
 WHERE c."id" = lm."chat_id";

--> statement-breakpoint
-- Watcher backfill: every active member whose managed (non-human) agent
-- participates in a chat where the member's own human agent is NOT a
-- speaking participant. Idempotent via ON CONFLICT.
INSERT INTO "chat_subscriptions"
  ("chat_id", "agent_id", "kind", "last_read_at", "unread_mention_count", "created_at")
SELECT DISTINCT cp."chat_id", m."agent_id", 'watching', NULL, 0, now()
  FROM "chat_participants" cp
  JOIN "agents"  a ON a."uuid" = cp."agent_id"
  JOIN "members" m ON m."id"   = a."manager_id"
 WHERE m."status" = 'active'
   AND a."type" <> 'human'
   AND NOT EXISTS (
     SELECT 1 FROM "chat_participants" cp2
      WHERE cp2."chat_id" = cp."chat_id"
        AND cp2."agent_id" = m."agent_id"
   )
ON CONFLICT ("chat_id", "agent_id") DO NOTHING;
