-- Add lifecycle_policy column to chats
ALTER TABLE "chats" ADD COLUMN "lifecycle_policy" text DEFAULT 'persistent';

--> statement-breakpoint
-- Adapter configs: Bot credentials for external platform adapters
CREATE TABLE "adapter_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"agent_id" text,
	"credentials" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Adapter chat mappings: internal Chat <-> external IM channel
CREATE TABLE "adapter_chat_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_channel_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_adapter_chat_mapping" ON "adapter_chat_mappings" ("platform", "external_channel_id", COALESCE("thread_id", ''));

--> statement-breakpoint
-- Adapter agent mappings: external user identity <-> internal Agent
CREATE TABLE "adapter_agent_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"bound_via" text,
	"display_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_adapter_agent_mapping" UNIQUE("platform","external_user_id")
);

--> statement-breakpoint
-- Adapter message references: internal Message <-> external message ID
CREATE TABLE "adapter_message_references" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"platform" text NOT NULL,
	"external_message_id" text NOT NULL,
	"external_channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_adapter_message_ref" UNIQUE("message_id","platform")
);

--> statement-breakpoint
-- Foreign keys for adapter tables
ALTER TABLE "adapter_configs" ADD CONSTRAINT "adapter_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "adapter_chat_mappings" ADD CONSTRAINT "adapter_chat_mappings_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "adapter_agent_mappings" ADD CONSTRAINT "adapter_agent_mappings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "adapter_message_references" ADD CONSTRAINT "adapter_message_references_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
