-- Adapter refactor: agentId required + unique constraint per design doc
-- Clean up any rows with NULL agent_id before adding NOT NULL constraint
DELETE FROM "adapter_configs" WHERE "agent_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "adapter_configs" ALTER COLUMN "agent_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "adapter_configs" ADD CONSTRAINT "uq_adapter_configs_agent_platform" UNIQUE("agent_id", "platform");

--> statement-breakpoint
-- Drop messages.sender_id FK — agents may be soft-deleted while messages are preserved
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_sender_id_agents_id_fk";
