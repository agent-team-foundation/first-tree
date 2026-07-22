ALTER TABLE "attachments" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "object_key" text;--> statement-breakpoint
CREATE INDEX "attachments_org_id_idx" ON "attachments" USING btree ("org_id");