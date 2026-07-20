CREATE TABLE "agent_provisioning_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"acting_agent_id" text NOT NULL,
	"managing_member_id" text NOT NULL,
	"created_agent_id" text NOT NULL,
	"chat_id" text,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "can_provision_agents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_provisioning_audit" ADD CONSTRAINT "agent_provisioning_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provisioning_audit" ADD CONSTRAINT "agent_provisioning_audit_acting_agent_id_agents_uuid_fk" FOREIGN KEY ("acting_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provisioning_audit" ADD CONSTRAINT "agent_provisioning_audit_managing_member_id_members_id_fk" FOREIGN KEY ("managing_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provisioning_audit" ADD CONSTRAINT "agent_provisioning_audit_created_agent_id_agents_uuid_fk" FOREIGN KEY ("created_agent_id") REFERENCES "public"."agents"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_provisioning_audit_org_created" ON "agent_provisioning_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_provisioning_audit_actor" ON "agent_provisioning_audit" USING btree ("acting_agent_id","created_at");