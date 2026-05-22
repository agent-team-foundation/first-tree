-- Track upstream PR/Issue lifecycle on github_entity_chat_mappings so the
-- chat auto-archive sweeper (services/chat-archive.ts) can decide whether
-- a chat's bound entities are all terminal (closed/merged) without making
-- GitHub API calls.
--
-- `entity_state` values: 'open' (default) | 'closed' | 'merged'. Written
-- by the webhook handler on PR closed/merged/reopened and Issue
-- closed/reopened (see api/webhooks/github-app.ts). Historical rows seeded
-- before this migration default to 'open'; an optional ops-only backfill
-- can later reconcile them against GitHub state.
--
-- The composite index (chat_id, entity_state) supports the sweeper's
-- "all entities settled?" aggregation query without bloating a wide
-- partial index.

ALTER TABLE "github_entity_chat_mappings"
  ADD COLUMN IF NOT EXISTS "entity_state" text NOT NULL DEFAULT 'open';

--> statement-breakpoint
ALTER TABLE "github_entity_chat_mappings"
  ADD COLUMN IF NOT EXISTS "entity_state_updated_at" timestamp with time zone;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_entity_chat_mappings_chat_state"
  ON "github_entity_chat_mappings" ("chat_id", "entity_state");
