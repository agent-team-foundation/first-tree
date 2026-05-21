import { customType, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { chats } from "./chats.js";
import { messages } from "./messages.js";

/**
 * `bytea` column type — Drizzle ships pg primitives but not bytea. Reads come
 * back as Node `Buffer` (postgres-js); writes accept any `Uint8Array`. Mirrors
 * the inline-avatar `bytea` in agents.ts; attachments are larger (≤10 MB) so the
 * download route streams and the column is set `STORAGE EXTERNAL` (no pointless
 * TOAST compression of already-compressed media) via a follow-up custom
 * migration — see drizzle/.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Message attachments — file bytes persisted server-side (route 2 / PG-bytea,
 * proposals/hub-message-text-attachments.20260521.md). The message itself only
 * carries references under `metadata.attachments[]` (A′); clients fetch bytes on
 * demand from the member-gated download route.
 *
 * Two-phase lifecycle: rows are created by the upload endpoint with
 * `message_id = NULL`, then bound to a message at send time (uploader + unbound
 * checks guard against cross-user reference). An orphan-GC sweep deletes rows
 * left unbound past a TTL. FK cascade removes attachments with their message /
 * chat.
 */
export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** NULL until the attachment is bound to a sent message. */
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    /** Agent uuid of the uploader. No FK — agents may be soft-deleted. */
    uploaderId: text("uploader_id").notNull(),
    mime: text("mime").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    /** "image" | "file" — render/delivery split (deriveAttachmentKind). */
    kind: text("kind").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_message_attachments_message").on(table.messageId),
    index("idx_message_attachments_chat").on(table.chatId),
    // Orphan-GC sweep: WHERE message_id IS NULL AND created_at < now() - ttl.
    index("idx_message_attachments_created").on(table.createdAt),
  ],
);
