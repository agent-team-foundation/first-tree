-- Hub Task — lightweight work units (tasks + task_chats)

CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"assignee_agent_id" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"origin_ref" text,
	"result" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_type" text,
	"cancelled_by_id" text
);
--> statement-breakpoint
CREATE TABLE "task_chats" (
	"task_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"linked_by_agent_id" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_chats_task_id_chat_id_pk" PRIMARY KEY("task_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_chats" ADD CONSTRAINT "task_chats_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_chats" ADD CONSTRAINT "task_chats_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_chats" ADD CONSTRAINT "task_chats_linked_by_agent_id_agents_uuid_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_org_status" ON "tasks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee_status" ON "tasks" USING btree ("assignee_agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_origin_ref" ON "tasks" USING btree ("origin_ref");--> statement-breakpoint
CREATE INDEX "idx_tasks_org_created_at" ON "tasks" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_chats_chat" ON "task_chats" USING btree ("chat_id");
