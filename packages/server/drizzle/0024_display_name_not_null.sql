-- Phase 2 of the agent-naming refactor (docs/agent-naming-design.md §4).
--
-- Before this migration, `display_name` was nullable and the web layer
-- silently fell back to `name` for rendering. CLI, server logs, and IM
-- bridges saw raw NULLs. This migration closes the gap in three steps:
--
--   1. Backfill every NULL row with a non-empty label — the agent's `name`
--      when available, else the tombstone literal "[deleted agent]".
--      Important: the third branch must NOT be `uuid`, because UUIDs would
--      surface as human-visible strings in the chat roster and IM bridge.
--      Only `status = 'deleted'` rows can have both `name` and
--      `display_name` NULL (see `deleteAgent` in services/agent.ts), which
--      is why the literal refers to deletion.
--
--   2. Add a temporary empty-string DEFAULT so any old server instance
--      still running during a rolling deploy — i.e. code that doesn't yet
--      default `display_name` in `createAgent` — can INSERT without
--      violating the upcoming NOT NULL. The application code treats an
--      empty string as "no display name" (the Zod read schema accepts it);
--      a follow-up migration can drop the default once the code is fully
--      rolled.
--
--   3. Promote the column to NOT NULL. Combined with the service-level
--      default this closes the hole for new rows too.

UPDATE "agents"
SET "display_name" = COALESCE("display_name", "name", '[deleted agent]')
WHERE "display_name" IS NULL;

ALTER TABLE "agents" ALTER COLUMN "display_name" SET DEFAULT '';
ALTER TABLE "agents" ALTER COLUMN "display_name" SET NOT NULL;
