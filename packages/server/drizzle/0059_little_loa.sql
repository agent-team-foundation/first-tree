CREATE TABLE "chat_create_operations" (
	"sender_agent_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"chat_id" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_create_operations_sender_agent_id_operation_id_pk" PRIMARY KEY("sender_agent_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "chat_create_operations" ADD CONSTRAINT "chat_create_operations_sender_agent_id_agents_uuid_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_create_operations" ADD CONSTRAINT "chat_create_operations_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_create_operations" ADD CONSTRAINT "chat_create_operations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_create_operations_chat" ON "chat_create_operations" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "idx_chat_create_operations_message" ON "chat_create_operations" USING btree ("message_id");