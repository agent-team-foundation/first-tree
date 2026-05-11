-- Pending ask-user question lifecycle. See packages/server/src/db/schema/pending-questions.ts
-- and services/questions.ts for the read / write paths.
--
-- One row per `format=question` message. Rows are written inside the same
-- transaction as the message INSERT (services/message.ts step 3b) so a
-- rollback drops both. Status flips to `answered` when the user posts an
-- answer, or to `superseded` when the chat session is archived
-- (services/session.ts archiveSession) or the owning client is claimed
-- away (services/client.ts claimClient).
--
-- Per the team's "integrity in service layer" convention, NO foreign-key
-- constraints — referential integrity is enforced by the question service.
-- A correlationId reuses the SDK `tool_use_id` so a single id flows from
-- the Claude Agent SDK callback through to the answer message.

CREATE TABLE IF NOT EXISTS "pending_questions" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "answered_at" timestamp with time zone,
  "superseded_at" timestamp with time zone,
  "superseded_reason" text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_questions_agent_status"
  ON "pending_questions" ("agent_id", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_questions_chat_status"
  ON "pending_questions" ("chat_id", "status");
