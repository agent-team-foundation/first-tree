import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Server-side lifecycle tracker for `format=question` messages.
 *
 * Written when an agent emits a question through `sendMessage`; status
 * flips to `answered` when the user posts an answer, or to `superseded`
 * when the chat session is archived or its client is claimed away.
 *
 * Per the team's "integrity in service layer" convention, NO foreign-key
 * constraints — referential integrity is enforced by the question
 * service itself (chat-id / agent-id / message-id are validated at
 * write time and the lifecycle hooks supersede orphaned rows).
 */
export const pendingQuestions = pgTable(
  "pending_questions",
  {
    /** Same id as the question's `correlationId` (carried in message content) — primary lookup key. */
    id: text("id").primaryKey(),
    /** Agent that emitted the question (sender of the `format=question` message). */
    agentId: text("agent_id").notNull(),
    /** Chat where the question was posted. */
    chatId: text("chat_id").notNull(),
    /** The `messages.id` row carrying this question. */
    messageId: text("message_id").notNull(),
    /** "pending" → "answered" | "superseded". */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** Free-form reason for supersede (e.g. "chat_archived", "client_claimed"). Null otherwise. */
    supersededReason: text("superseded_reason"),
  },
  (table) => [
    index("idx_pending_questions_agent_status").on(table.agentId, table.status),
    index("idx_pending_questions_chat_status").on(table.chatId, table.status),
  ],
);
