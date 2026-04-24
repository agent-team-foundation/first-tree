-- Phase 2 of the agent-naming refactor (docs/agent-naming-design.md §4).
--
-- Before this migration, `display_name` was nullable and the web layer
-- silently fell back to `name` for rendering. That left CLI, server logs,
-- and IM-bridge notifications looking at raw NULLs or placeholders. This
-- migration closes the gap by (a) backfilling every NULL row from the
-- agent's `name` (or `uuid` when both are NULL — only possible for
-- tombstoned rows whose name was cleared on delete) and (b) promoting the
-- column to NOT NULL so new rows can't recreate the hole.
--
-- Deploy with the matching service change that defaults `display_name` to
-- `name` on create: without it, concurrent inserts during the rollout
-- window could fail the new constraint.

UPDATE "agents"
SET "display_name" = COALESCE("display_name", "name", "uuid")
WHERE "display_name" IS NULL;

ALTER TABLE "agents" ALTER COLUMN "display_name" SET NOT NULL;
