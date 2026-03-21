-- v2 schema updates

-- Add new column to chats table
ALTER TABLE "chats" ADD COLUMN "parent_chat_id" text;

-- Agent presence table
CREATE TABLE "agent_presence" (
    "agent_id" text PRIMARY KEY REFERENCES "agents"("id") ON DELETE CASCADE,
    "status" text NOT NULL DEFAULT 'offline',
    "instance_id" text,
    "connected_at" timestamptz,
    "last_seen_at" timestamptz NOT NULL DEFAULT NOW()
);

-- Server instances table
CREATE TABLE "server_instances" (
    "instance_id" text PRIMARY KEY,
    "last_heartbeat" timestamptz NOT NULL DEFAULT NOW()
);

-- System configs table
CREATE TABLE "system_configs" (
    "key" text PRIMARY KEY,
    "value" jsonb NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT NOW()
);