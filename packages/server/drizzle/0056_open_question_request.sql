ALTER TABLE "chat_user_state" ADD COLUMN "open_request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_user_state_open_req" ON "chat_user_state" USING btree ("agent_id") WHERE open_request_count > 0;--> statement-breakpoint
CREATE INDEX "idx_messages_mentions" ON "messages" USING gin ((("metadata" -> 'mentions')) jsonb_path_ops);