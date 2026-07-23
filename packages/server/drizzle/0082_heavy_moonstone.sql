CREATE TABLE "cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_member_id" text NOT NULL,
	"control_chat_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"chat_mode" text DEFAULT 'reuse_control_chat' NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text NOT NULL,
	"prompt" text NOT NULL,
	"state" text NOT NULL,
	"state_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_trigger_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_cron_jobs_control_agent_name" UNIQUE("control_chat_id","agent_id","name"),
	CONSTRAINT "ck_cron_jobs_state" CHECK ("cron_jobs"."state" IN ('active', 'paused')),
	CONSTRAINT "ck_cron_jobs_chat_mode" CHECK ("cron_jobs"."chat_mode" = 'reuse_control_chat'),
	CONSTRAINT "ck_cron_jobs_revision_positive" CHECK ("cron_jobs"."revision" > 0),
	CONSTRAINT "ck_cron_jobs_active_shape" CHECK (("cron_jobs"."state" = 'active' AND "cron_jobs"."next_run_at" IS NOT NULL AND "cron_jobs"."state_reason" IS NULL) OR ("cron_jobs"."state" = 'paused' AND "cron_jobs"."next_run_at" IS NULL AND "cron_jobs"."state_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_control_chat_id_chats_id_fk" FOREIGN KEY ("control_chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_agent_id_agents_uuid_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_last_trigger_message_id_messages_id_fk" FOREIGN KEY ("last_trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cron_jobs_due" ON "cron_jobs" USING btree ("next_run_at","id") WHERE "cron_jobs"."state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_cron_jobs_control_created" ON "cron_jobs" USING btree ("control_chat_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_cron_jobs_owner_created" ON "cron_jobs" USING btree ("owner_member_id","created_at");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "ck_clients_paused_reason" CHECK ("clients"."paused_reason" IS NULL OR "clients"."paused_reason" IN ('auth_rejected', 'auth_refresh_failed'));