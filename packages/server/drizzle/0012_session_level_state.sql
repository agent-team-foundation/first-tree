-- Session-level state reporting: new session table + drop unused presence columns

CREATE TABLE "agent_chat_sessions" (
	"agent_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chat_sessions_agent_id_chat_id_pk" PRIMARY KEY("agent_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_agent_id_agents_uuid_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("uuid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_presence" DROP COLUMN IF EXISTS "runtime_description";
--> statement-breakpoint
ALTER TABLE "agent_presence" DROP COLUMN IF EXISTS "error_message";
--> statement-breakpoint
ALTER TABLE "agent_presence" DROP COLUMN IF EXISTS "task_ref";
