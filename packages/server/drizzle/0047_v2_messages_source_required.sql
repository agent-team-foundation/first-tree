-- v2: messages.source is now required (NOT NULL) and renamed legacy
-- 'hub_ui' rows to 'web'. Adds a (chat_id, source, created_at desc)
-- composite index so observability / loop / egress queries can group by
-- caller-stack origin without scanning. See
-- proposals/hub-chat-message-v2-simplify-mode.20260520.md §四.

-- Step 1: Rename existing 'hub_ui' rows to 'web' — align with the
-- caller-type naming dimension shared by 'cli' / 'feishu' / 'github' /
-- 'api'. Older rows that pre-date the column being widely populated may
-- still be NULL; step 2 handles those.
UPDATE "messages" SET "source" = 'web' WHERE "source" = 'hub_ui';

--> statement-breakpoint
-- Step 2: Backfill NULL rows. Heuristic by sender type: human-typed
-- senders → 'web' (the only NULL-source path that wrote human messages
-- was the web UI before the column existed), non-human → 'api' (the
-- agent CLI / SDK / result-sink path that historically did not set the
-- column). Best-effort reconciliation; older rows whose sender has since
-- been hard-deleted fall back to 'api' via the agents-row lookup being
-- empty (sender_id no longer joins) — `COALESCE` collapses that to 'api'
-- rather than leaving a NULL behind which the NOT NULL step would
-- reject.
UPDATE "messages" m SET "source" = (
  COALESCE(
    (SELECT CASE WHEN a."type" = 'human' THEN 'web' ELSE 'api' END
       FROM "agents" a
      WHERE a."uuid" = m."sender_id"),
    'api'
  )
) WHERE "source" IS NULL;

--> statement-breakpoint
-- Step 3: Lock down NOT NULL.
ALTER TABLE "messages" ALTER COLUMN "source" SET NOT NULL;

--> statement-breakpoint
-- Step 4: Index for source-grouped queries (loop / egress / observability).
CREATE INDEX IF NOT EXISTS "idx_messages_chat_source_time"
  ON "messages" ("chat_id", "source", "created_at" DESC);
