import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { attachments } from "./attachments.js";
import { messages } from "./messages.js";

/**
 * Reference ledger: one row per (attachment, message) link, maintained in
 * the same transaction as the message write. A message references an
 * attachment when its `content` carries an `imageId` (single or batch
 * form) or its `metadata.attachments[]` carries an `attachmentId` —
 * `collectAttachmentIds` in services/attachment-references.ts is the single
 * source of truth for that discovery.
 *
 * The ledger exists so lifecycle checks are O(1) lookups instead of
 * whole-table jsonb scans: "delete on last reference removed" checks for
 * remaining edges, and the orphan sweep treats zero-edge rows as candidates
 * (with a full-scan verify veto as the safety net for rows uploaded before
 * the backfill ran — see services/attachment-sweep.ts).
 *
 * FK discipline: `attachment_id` deliberately has NO cascade. Every
 * legitimate row-delete path proves the edge count is zero before deleting
 * the attachment, so a cascade could only ever fire on a logic bug deleting
 * a still-referenced attachment — and would then silently destroy the
 * evidence. RESTRICT turns that bug into a loud constraint violation.
 * `message_id` has no cascade either: messages are immutable and never
 * row-deleted (enforced today by inbound RESTRICT FKs).
 */
export const attachmentReferences = pgTable(
  "attachment_references",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.messageId] }),
    /** Edit-time recompute: fetch the current edge set of one message. */
    index("attachment_references_message_id_idx").on(table.messageId),
  ],
);
