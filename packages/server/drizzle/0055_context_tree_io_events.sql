-- Context Tree IO events — durable facts for explicit first-tree-context reads/writes.
--
-- Hand-authored because `drizzle-kit generate` currently fails on this repo's
-- pre-existing snapshot drift (collision between 0016 and 0018 meta snapshots).
-- This follows the same journal + LATEST bump pattern as 0052 and 0054.

CREATE TABLE IF NOT EXISTS "context_tree_io_events" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "chat_id" text NOT NULL,
  "source_session_event_id" text NOT NULL,
  "source_index" integer NOT NULL DEFAULT 0,
  "runtime_provider" text NOT NULL,
  "action" text NOT NULL,
  "source" text NOT NULL,
  "tree_repo_url" text NOT NULL,
  "tree_branch" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_path" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "context_tree_io_events_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id"),
  CONSTRAINT "context_tree_io_events_agent_id_agents_uuid_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("uuid"),
  CONSTRAINT "context_tree_io_events_chat_id_chats_id_fk"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id"),
  CONSTRAINT "ck_context_tree_io_action"
    CHECK ("action" IN ('read', 'write')),
  CONSTRAINT "ck_context_tree_io_target_kind"
    CHECK ("target_kind" IN ('file', 'directory', 'repo')),
  CONSTRAINT "ck_context_tree_io_target_path_nonempty"
    CHECK ("target_path" <> '')
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_context_tree_io_source"
  ON "context_tree_io_events" ("source_session_event_id", "source_index");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_context_tree_io_org_recent"
  ON "context_tree_io_events" ("organization_id", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_context_tree_io_org_action_recent"
  ON "context_tree_io_events" ("organization_id", "action", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_context_tree_io_org_agent_recent"
  ON "context_tree_io_events" ("organization_id", "agent_id", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_context_tree_io_org_target_recent"
  ON "context_tree_io_events" ("organization_id", "target_path", "created_at" DESC);
