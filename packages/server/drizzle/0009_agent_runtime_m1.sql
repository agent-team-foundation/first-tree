-- M1: Agent Runtime — Process Awareness
-- New clients table + agent_presence runtime columns

CREATE TABLE IF NOT EXISTS "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"sdk_version" text,
	"hostname" text,
	"os" text,
	"instance_id" text,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);

ALTER TABLE "agent_presence" ADD COLUMN "client_id" text;
ALTER TABLE "agent_presence" ADD COLUMN "runtime_type" text;
ALTER TABLE "agent_presence" ADD COLUMN "runtime_version" text;
ALTER TABLE "agent_presence" ADD COLUMN "runtime_state" text;
ALTER TABLE "agent_presence" ADD COLUMN "runtime_description" text;
ALTER TABLE "agent_presence" ADD COLUMN "active_sessions" integer;
ALTER TABLE "agent_presence" ADD COLUMN "total_sessions" integer;
ALTER TABLE "agent_presence" ADD COLUMN "error_message" text;
ALTER TABLE "agent_presence" ADD COLUMN "task_ref" text;
ALTER TABLE "agent_presence" ADD COLUMN "runtime_updated_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
