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
