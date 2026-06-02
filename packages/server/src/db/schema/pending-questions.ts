import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * ⚠️ LEGACY AUDIT TABLE — retained for drizzle-kit parity ONLY.
 *
 * The `format=question` ask-user path and its supersede hooks were removed
 * end-to-end (no service or runtime reads this table). The `pending_questions`
 * table + its rows are deliberately KEPT in the database as a dead audit
 * snapshot — see migration `0034_pending_questions.sql`, which is NOT rolled
 * back.
 *
 * This definition exists so `drizzle-kit generate` (which diffs
 * `src/db/schema/index.ts` against the migration journal) continues to see the
 * table and does NOT emit a spurious `DROP TABLE pending_questions` that would
 * destroy those audit rows. Do NOT import this at runtime; do NOT add new
 * reads/writes. When the team decides to truly retire the data, drop this file
 * + add a single `DROP TABLE` migration in the same change.
 */
export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededReason: text("superseded_reason"),
  },
  (table) => [
    index("idx_pending_questions_agent_status").on(table.agentId, table.status),
    index("idx_pending_questions_chat_status").on(table.chatId, table.status),
  ],
);
