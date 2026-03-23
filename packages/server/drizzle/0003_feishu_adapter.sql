-- Webhook event deduplication table
CREATE TABLE IF NOT EXISTS "processed_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "platform" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_processed_event" UNIQUE("event_id","platform")
);

-- Performance indexes for adapter mapping lookups
CREATE INDEX IF NOT EXISTS "idx_adapter_chat_mappings_lookup"
  ON "adapter_chat_mappings" ("platform", "external_channel_id");

CREATE INDEX IF NOT EXISTS "idx_adapter_agent_mappings_lookup"
  ON "adapter_agent_mappings" ("platform", "external_user_id");

CREATE INDEX IF NOT EXISTS "idx_adapter_message_refs_lookup"
  ON "adapter_message_references" ("platform", "external_message_id");

CREATE INDEX IF NOT EXISTS "idx_adapter_configs_active"
  ON "adapter_configs" ("platform") WHERE "status" = 'active';
