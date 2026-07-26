import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { chats } from "./chats.js";

/** Messages. Immutable after creation. Each message belongs to exactly one Chat. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    /** No FK constraint — agents may be soft-deleted while messages are preserved. */
    senderId: text("sender_id").notNull(),
    /** "text" | "markdown" | "card" | "reference" | "file" | "request" */
    format: text("format").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Decision-inert column. Originally an inbox-row-level reply-routing
     * envelope paired with the now-removed `replyToChat` cross-chat hint;
     * once cross-chat routing went away there were no consumers left (the
     * receive-side `shouldSuppressEcho` was deleted with it). The column
     * survives as schema scaffolding only — the business layer never writes
     * a non-null value. Do NOT reintroduce reply-routing envelopes here;
     * inbox fan-out is sufficient, see first-tree-context PR #281.
     */
    replyToInbox: text("reply_to_inbox"),
    /**
     * Decision-inert column. Originally part of a cross-chat reply-routing
     * mechanism that has been removed (see first-tree-context PR #281).
     * The column is retained as schema scaffolding only — the business layer
     * never writes a non-null value. Do NOT reintroduce cross-chat reply
     * routing through this column.
     */
    replyToChat: text("reply_to_chat"),
    /**
     * Original message ID; threads replies in the same chat. Maintained
     * field (NOT decision-inert — unlike `replyToInbox`/`replyToChat`).
     * Consumers: loop-detector reply-chain guard C4, client dispatcher /
     * inbox / chat-list projections, and conversation threading for the
     * open-question "chat about this" discussion line.
     *
     * Pure threading: `inReplyTo` does NOT change a `format='request'`
     * question's lifecycle. A question is answered/closed only by an
     * explicit `metadata.resolves` signal (see shared `requestResolutionSchema`),
     * which is what decrements `chat_user_state.open_request_count`. (Keep
     * decision per issue #754: do NOT remove this column.)
     */
    inReplyTo: text("in_reply_to"),
    /**
     * Entry point that created this message: web / cli / github / gitlab / api.
     * NOT NULL after migration 0047 — every write path declares its
     * caller-stack origin so observability / loop / egress diagnostics can
     * group on it without a backfilling join.
     */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_chat_time").on(table.chatId, table.createdAt),
    index("idx_messages_in_reply_to").on(table.inReplyTo),
    index("idx_messages_chat_source_time").on(table.chatId, table.source, table.createdAt.desc()),
    /**
     * GIN over the `metadata.mentions` uuid array — serves "messages
     * mentioning member X" lookups (the cross-chat "open questions directed
     * at me" list). `jsonb_path_ops` is the smaller/faster opclass for the
     * containment query `metadata -> 'mentions' @> '["<uuid>"]'`.
     */
    index("idx_messages_mentions").using("gin", sql`((${table.metadata} -> 'mentions')) jsonb_path_ops`),
  ],
);
