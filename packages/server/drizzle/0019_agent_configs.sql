-- M1 agent configuration: Hub-managed runtime config table.
-- Creates `agent_configs` and back-fills one row per non-deleted agent so
-- Step 6 can flip Claude Code handler over to read prompt from config without
-- silently dropping the existing `agents.profile` text.

CREATE TABLE IF NOT EXISTS "agent_configs" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"payload" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
INSERT INTO "agent_configs" ("agent_id", "version", "payload", "updated_by", "updated_at")
SELECT
  "uuid",
  1,
  jsonb_build_object(
    'prompt', jsonb_build_object('append', COALESCE("profile", '')),
    'model', '',
    'mcpServers', '[]'::jsonb,
    'env', '[]'::jsonb,
    'gitRepos', '[]'::jsonb
  ),
  'system',
  now()
FROM "agents"
WHERE "status" != 'deleted'
ON CONFLICT ("agent_id") DO NOTHING;
