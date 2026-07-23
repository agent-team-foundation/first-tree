CREATE TABLE "attachment_references" (
	"attachment_id" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_references_attachment_id_message_id_pk" PRIMARY KEY("attachment_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "avatar_object_key" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "state" text DEFAULT 'stored' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_references" ADD CONSTRAINT "attachment_references_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_references" ADD CONSTRAINT "attachment_references_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_references_message_id_idx" ON "attachment_references" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_org_state_idx" ON "attachments" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "attachments_state_created_at_idx" ON "attachments" USING btree ("state","created_at");