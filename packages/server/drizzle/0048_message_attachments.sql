-- Message attachments — file bytes persisted server-side (route 2 / PG-bytea).
-- See proposals/hub-message-text-attachments.20260521.md.
--
-- NOTE: hand-authored. `drizzle-kit generate` cannot run on this branch — the
-- drizzle/meta snapshot chain is incomplete (48 journal entries, 7 snapshots),
-- so generate aborts with a snapshot collision. This migration is purely
-- additive (one new table) and follows drizzle's output format; recent
-- migrations here (e.g. 0045) are likewise hand-curated. Reconcile the meta
-- snapshot chain separately (infra follow-up) if `generate` is needed again.
CREATE TABLE "message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text,
	"uploader_id" text NOT NULL,
	"mime" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"kind" text NOT NULL,
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_attachments_message" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_message_attachments_chat" ON "message_attachments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "idx_message_attachments_created" ON "message_attachments" USING btree ("created_at");--> statement-breakpoint
-- Already-compressed media → skip pointless TOAST compression; store out-of-line.
ALTER TABLE "message_attachments" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
