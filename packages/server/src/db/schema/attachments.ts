import { customType, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

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
 * Attachment lifecycle states.
 *
 * - `pending`  — row inserted as a durable quota reservation; the payload is
 *   still streaming to object storage. Invisible to download, not
 *   referenceable, reclaimed by the sweep once older than the pending TTL.
 * - `stored`   — payload verified in object storage (or, transitionally, in
 *   the legacy `data` bytea). Downloadable and referenceable.
 * - `deleting` — tombstone claimed for deletion (orphan sweep or
 *   last-reference-removed). Invisible and blocks new references; the
 *   object and row are removed next, and a crash in between is retried by
 *   the sweep (object deletion is idempotent).
 */
export const ATTACHMENT_STATES = ["pending", "stored", "deleting"] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

/**
 * Attachment metadata. The binary payload lives in S3-compatible object
 * storage under the deterministic key `attachments/<id>`; PostgreSQL keeps
 * metadata plus lifecycle state only.
 *
 * Independent blob — intentionally NO `chat_id` / `message_id` columns.
 * Upstream consumers (the `imageId` field inside `messages.content` jsonb,
 * `metadata.attachments[]` refs) hold the `attachments.id` reference; the
 * `attachment_references` edge table records those links for O(1)
 * lifecycle checks (see attachment-references.ts).
 *
 * Auth happens at the route layer as a capability model: download requires
 * a valid user JWT plus knowledge of the unguessable UUIDv4 id; there is no
 * per-attachment ACL. Stronger, attachment-scoped authorization is the
 * consumer's responsibility. Upload is org-scoped
 * (`POST /api/v1/orgs/:orgId/attachments`) so `uploaded_by` resolves to a
 * stable member identity and quota accounting has an owner.
 *
 * Lifecycle: three-state (see `ATTACHMENT_STATES`). Unreferenced `stored`
 * rows older than the orphan grace window are deleted by the background
 * sweep; removing the last remaining reference deletes immediately.
 */
export const attachments = pgTable(
  "attachments",
  {
    /** UUIDv4. Same value upstream references store. */
    id: text("id").primaryKey(),
    /**
     * Owning organization — the quota accounting unit. Nullable only for
     * legacy rows whose uploader row disappeared before the migration
     * backfill ran; such rows are exempt from quota sums. New uploads
     * always set it.
     */
    organizationId: text("organization_id").references(() => organizations.id),
    /** MIME as declared by the uploader. v1 does not restrict. */
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    /** Server-measured byte length; clients do not get to lie about this. */
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Object-storage key of the payload (`attachments/<id>`). NULL only on
     * legacy rows whose payload still sits in `data` — the migration
     * command sets the key and clears the bytea in one statement.
     */
    objectKey: text("object_key"),
    /**
     * Lifecycle state (`ATTACHMENT_STATES`). The column default exists ONLY
     * so pre-existing rows became valid `stored` rows when the column was
     * added — new code must always set `state` explicitly.
     */
    state: text("state").$type<AttachmentState>().notNull().default("stored"),
    /**
     * Legacy inline payload. The `migrate:attachments` command moves it to
     * object storage and NULLs it; dropping the column entirely is a
     * follow-up once deployments have migrated.
     */
    data: bytea("data"),
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
    /** Quota sums: `WHERE organization_id = $1 AND state IN ('pending','stored')`. */
    index("attachments_org_state_idx").on(table.organizationId, table.state),
    /** Sweep scans: expired `pending`, orphan-aged `stored`, leftover `deleting`. */
    index("attachments_state_created_at_idx").on(table.state, table.createdAt),
  ],
);
