-- NC2 (workspace-redesign S10): drop `session_outputs`, add `session_events`.
--
-- The old table held one `content` row per (agent, chat) with string
-- concatenation on upsert. The new table captures structured events
-- (`tool_call` / `error`) with a monotonic per-chat `seq` and a jsonb
-- payload. Integrity is enforced in the service layer (Zod discriminated
-- union on insert), so no FK / CHECK here — matches the project rule for
-- new tables.
--
-- Discarding `session_outputs` data is intentional (tech plan decision):
-- no content-migration path, no compatibility shim.

DROP TABLE IF EXISTS "session_outputs" CASCADE;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_session_events_chat_seq"
	ON "session_events" ("agent_id", "chat_id", "seq");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_events_chat_created"
	ON "session_events" ("agent_id", "chat_id", "created_at" DESC);
