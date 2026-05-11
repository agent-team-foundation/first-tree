-- Drop the Hub Task subsystem. The product no longer uses tasks; the
-- chat-first workspace covers every flow that previously needed task rows.
-- Order matches the historical service-layer dependency; DB-level FKs were
-- already removed in 0014_drop_task_fks so either order would technically work.

DROP TABLE IF EXISTS "task_chats";--> statement-breakpoint
DROP TABLE IF EXISTS "tasks";
