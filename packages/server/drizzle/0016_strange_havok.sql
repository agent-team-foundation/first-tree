CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"agent_id" text,
	"chat_id" text,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source" text;--> statement-breakpoint
CREATE INDEX "idx_notifications_org_created" ON "notifications" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_agent" ON "notifications" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_org_read" ON "notifications" USING btree ("organization_id","read");--> statement-breakpoint
CREATE INDEX "idx_session_outputs_agent_chat" ON "session_outputs" USING btree ("agent_id","chat_id");