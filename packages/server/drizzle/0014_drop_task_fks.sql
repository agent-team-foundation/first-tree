-- Drop all FK constraints from the Hub Task tables.
-- Referential integrity for tasks/task_chats is enforced in the service layer;
-- DB-level FKs transfer the cost (cascade surprises, migration friction, test
-- setup complexity) onto the database without adding value here.

ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "task_chats" DROP CONSTRAINT IF EXISTS "task_chats_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_chats" DROP CONSTRAINT IF EXISTS "task_chats_chat_id_chats_id_fk";--> statement-breakpoint
ALTER TABLE "task_chats" DROP CONSTRAINT IF EXISTS "task_chats_linked_by_agent_id_agents_uuid_fk";
