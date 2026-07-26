-- Chat-list refactor — data foundation.
--   1. chat_user_state: add per-user `pinned_at` (nullable) + partial index.
--      NULL = not pinned, so no backfill is needed for existing rows.
--   2. chats: add `activity_at` (the conversation-list recency sort key) +
--      backfill + (organization_id, activity_at DESC) index.
--
-- `activity_at` advances only on real work (a new message or a genuine
-- description change), never on rename/read/pin/archive/participant/busy. New
-- rows default to now() (= creation time); existing rows are backfilled to
-- max(last_message_at, description_updated_at, created_at). The backfill runs
-- before the activity index so the index builds on final values.
ALTER TABLE "chat_user_state" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- The ADD COLUMN default set every existing row to the migration-time now();
-- reset them to real activity. last_message_at / description_updated_at are
-- nullable, so COALESCE each to created_at before GREATEST.
UPDATE "chats" SET "activity_at" = GREATEST(
  COALESCE("last_message_at", "created_at"),
  COALESCE("description_updated_at", "created_at"),
  "created_at"
);--> statement-breakpoint
CREATE INDEX "idx_user_state_pinned" ON "chat_user_state" USING btree ("agent_id") WHERE pinned_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_chats_org_activity" ON "chats" USING btree ("organization_id","activity_at" desc);
