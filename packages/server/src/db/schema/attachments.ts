import { customType, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `bytea` column type. Drizzle ships pg primitives but not bytea out of the
 * box. Reads come back as Node `Buffer` (postgres-js); writes accept any
 * `Uint8Array`. Mirrors the helper in `agents.ts` — kept local to this file
 * so the two columns can diverge independently if one ever needs a different
 * marshalling story.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Server-side blob storage primitive. The first-tree object-storage layer.
 *
 * Independent blob — intentionally NO `chat_id` / `message_id` columns.
 * Upstream consumers (the `imageId` field inside `messages.content` jsonb,
 * future bookmark metadata, agent avatar references) hold the
 * `attachments.id` reference. One byte sequence, many consumers.
 *
 * Auth happens at the route layer as a capability model: download requires
 * a valid user JWT plus knowledge of the unguessable UUIDv4 id; there is no
 * per-attachment ACL. Stronger, attachment-scoped authorization is the
 * consumer's responsibility. Upload is org-scoped
 * (`POST /api/v1/orgs/:orgId/attachments`) so `uploaded_by` resolves to a
 * stable member identity.
 *
 * Storage is dual-track during the S3 migration window: rows with a
 * non-null `object_key` have their bytes in S3 (`data` is NULL); rows with
 * a null `object_key` and non-null `data` are pre-migration legacy rows
 * still served from Postgres. `scripts/migrate-attachments-to-s3.ts` drains
 * the legacy track; the physical `data` column drop is a follow-up.
 *
 * Lifecycle: bounded. Org quotas (2 GiB / 1000 objects, see
 * `ORG_ATTACHMENT_MAX_*` in shared) are enforced on upload, and rows no
 * known reference point uses are deleted by the orphan sweeper (24h grace)
 * or immediately when a message edit drops the last reference.
 */
export const attachments = pgTable(
  "attachments",
  {
    /** UUIDv4. Same value upstream references store. */
    id: text("id").primaryKey(),
    /** MIME as declared by the uploader. v1 does not restrict. */
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    /** Server-measured byte length; clients do not get to lie about this. */
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Legacy inline bytes. NULL for every S3-backed row; non-null only on
     * pre-migration rows until `migrate-attachments-to-s3.ts` drains them.
     */
    data: bytea("data"),
    /**
     * Owning organization — the upload route's `:orgId` for new rows;
     * backfilled via `uploaded_by → agents.organization_id` for legacy rows
     * (NULL when the uploader's org cannot be resolved). Drives org quota
     * accounting; nullable so pre-migration rows migrate without a lock.
     */
    orgId: text("org_id"),
    /**
     * S3 object key (`attachments/<orgId>/<id>`). NULL = legacy bytea row.
     */
    objectKey: text("object_key"),
    /**
     * `agents.uuid` of the team member who uploaded these bytes. Humans
     * store their `humanAgentId`; AI agents store their own uuid. No FK —
     * mirrors `messages.sender_id`, which dropped its FK so soft-deleting
     * an agent does not cascade or orphan existing rows.
     */
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attachments_uploaded_by_idx").on(table.uploadedBy),
    index("attachments_created_at_idx").on(table.createdAt),
    index("attachments_org_id_idx").on(table.orgId),
  ],
);
