ALTER TABLE "chat_participants"
  ADD COLUMN "engagement_status" text NOT NULL DEFAULT 'active';--> statement-breakpoint

ALTER TABLE "chat_subscriptions"
  ADD COLUMN "engagement_status" text NOT NULL DEFAULT 'active';
