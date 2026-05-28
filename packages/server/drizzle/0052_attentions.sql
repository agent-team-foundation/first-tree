-- NHA M1 末 (Need Human Attention) — backing store for the attention primitive.
-- See packages/server/src/db/schema/attentions.ts and services/attention.ts
-- for the read / write paths.
--
-- One row per Attention raised by an agent against exactly one human in a
-- chat. Per the team's "integrity in service layer" convention there are NO
-- foreign-key constraints — the attention service validates that:
--   - origin_agent is a speaker of origin_chat,
--   - target_human is an `agents` row with `type='human'` and a member of origin_chat,
--   - respond is authored by target_human and cancel by origin_agent,
--   - closed records are immutable.
--
-- Hand-authored because `drizzle-kit generate` fails on this repo's
-- pre-existing snapshot drift (drizzle/meta has missing intermediate
-- snapshots — collision between 0016 and 0018). The journal + LATEST are
-- bumped manually alongside this file.

CREATE TABLE IF NOT EXISTS "attentions" (
  "id" text PRIMARY KEY NOT NULL,
  "origin_agent_id" text NOT NULL,
  "origin_chat_id" text NOT NULL,
  "target_human_id" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "requires_response" boolean NOT NULL DEFAULT false,
  "state" text NOT NULL DEFAULT 'open',
  "response" text,
  "responded_by" text,
  "responded_at" timestamp with time zone,
  "cancelled" boolean NOT NULL DEFAULT false,
  "cancelled_reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attentions_target_open"
  ON "attentions" ("target_human_id", "state");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attentions_chat_open"
  ON "attentions" ("origin_chat_id", "state");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attentions_origin"
  ON "attentions" ("origin_agent_id", "created_at");
