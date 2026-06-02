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
 * Lifecycle: write-once. v1 keeps every row forever. A refcount /
 * orphan-sweep job is a follow-up only if storage growth demands it; it
 * would have to scan every known upstream reference site.
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
    data: bytea("data").notNull(),
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
  ],
);
