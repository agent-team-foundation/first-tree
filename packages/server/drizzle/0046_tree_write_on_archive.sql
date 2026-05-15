-- Archive-triggered Context Tree write queue.
--
-- Generated from the schema diff between:
--   1. a clean `origin/main` baseline snapshot
--   2. the current tree-write-on-archive schema
--
-- The repo's in-tree drizzle meta snapshots are currently inconsistent
-- (0016/0018 collision), so `drizzle-kit generate` cannot emit directly into
-- `packages/server/drizzle/`. This SQL preserves the generated structural
-- changes while leaving the broken snapshot chain untouched.

ALTER TABLE "agent_presence"
  ADD COLUMN "context_tree_repo_url" text;
--> statement-breakpoint
ALTER TABLE "agent_presence"
  ADD COLUMN "context_tree_branch" text;
--> statement-breakpoint
ALTER TABLE "agent_presence"
  ADD COLUMN "context_tree_verification_status" text;
--> statement-breakpoint
ALTER TABLE "agent_presence"
  ADD COLUMN "context_tree_updated_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "agents"
  ADD COLUMN "tree_write_on_archive" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "chat_user_state"
  ADD COLUMN "archive_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

CREATE TABLE "tree_write_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "source_chat_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "archive_seq" integer NOT NULL,
  "agent_id" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "exec_chat_id" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "result_kind" text,
  "result_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uq_tree_write_tasks_source_owner_archive"
  ON "tree_write_tasks" USING btree ("source_chat_id", "owner_user_id", "archive_seq");
--> statement-breakpoint
CREATE INDEX "idx_tree_write_tasks_state_next_attempt"
  ON "tree_write_tasks" USING btree ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "idx_tree_write_tasks_agent"
  ON "tree_write_tasks" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_tree_write_tasks_source_chat"
  ON "tree_write_tasks" USING btree ("source_chat_id");
