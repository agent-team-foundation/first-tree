-- Drop the Hub Task subsystem. The product no longer uses tasks; the
-- chat-first workspace covers every flow that previously needed task rows.
-- task_chats first (it has a soft reference to tasks), then tasks.

DROP TABLE IF EXISTS "task_chats";--> statement-breakpoint
DROP TABLE IF EXISTS "tasks";
