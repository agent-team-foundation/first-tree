-- attachments — first-tree object-storage primitive.
--
-- See packages/server/src/db/schema/attachments.ts for the read/write
-- story and design rationale.
--
-- Independent blob — NO chat_id / message_id columns. Upstream consumers
-- (messages.content jsonb today, attentions / bookmark / avatar metadata
-- tomorrow) hold the `attachments.id` reference. No foreign keys —
-- consistent with messages.sender_id, which drops its FK so soft-deleting
-- an agent leaves existing rows intact. v1 keeps every row forever;
-- refcount / orphan-sweep is a follow-up only if storage growth demands.
--
-- Auth happens at the route layer as a capability model: download requires
-- a valid user JWT plus knowledge of the unguessable UUIDv4 id; there is no
-- per-attachment ACL. Stronger, attachment-scoped authorization is the
-- consumer's responsibility. Upload is org-scoped
-- (POST /api/v1/orgs/:orgId/attachments) so uploaded_by resolves to a stable
-- member identity.
--
-- Hand-authored alongside the journal + LATEST bump because drizzle-kit
-- generate fails on this repo's pre-existing snapshot drift (see the 0052
-- header note for the same rationale).

CREATE TABLE IF NOT EXISTS "attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "mime_type" text NOT NULL,
  "filename" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "data" bytea NOT NULL,
  "uploaded_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_uploaded_by_idx"
  ON "attachments" ("uploaded_by");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_created_at_idx"
  ON "attachments" ("created_at");
