-- Add runtime_provider to agents.
--
-- Tags each agent with the runtime that drives it (e.g. "claude-code", "codex").
-- DEFAULT 'claude-code' backfills every existing row so the NOT NULL constraint
-- is safe to land in a single step. Hub deploys are stop-migrate-restart, not
-- rolling, so we don't need a two-phase add (nullable → backfill → not null).
--
-- Capabilities reporting reuses the existing `clients.metadata` jsonb column
-- under the `capabilities` subkey (Option C); no SQL change for clients.
ALTER TABLE "agents" ADD COLUMN "runtime_provider" text DEFAULT 'claude-code' NOT NULL;
