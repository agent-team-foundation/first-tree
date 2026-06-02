import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * ⚠️ LEGACY AUDIT TABLE — retained for drizzle-kit parity ONLY.
 *
 * The NHA (Need-Human-Attention) feature was removed end-to-end (no service,
 * API, CLI, or runtime reads this table). The `attentions` table + its rows
 * are deliberately KEPT in the database as a dead audit snapshot of the
 * dogfood era — see migration `0052_attentions.sql`, which is NOT rolled back.
 *
 * This definition exists so `drizzle-kit generate` (which diffs
 * `src/db/schema/index.ts` against the migration journal) continues to see the
 * table and does NOT emit a spurious `DROP TABLE attentions` that would destroy
 * those audit rows. Do NOT import this at runtime; do NOT add new reads/writes.
 * When the team decides to truly retire the data, drop this file + add a single
 * `DROP TABLE` migration in the same change.
 */
export const attentions = pgTable(
  "attentions",
  {
    id: text("id").primaryKey(),
    originAgentId: text("origin_agent_id").notNull(),
    originChatId: text("origin_chat_id").notNull(),
    targetHumanId: text("target_human_id").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull().default(""),
    requiresResponse: boolean("requires_response").notNull().default(false),
    state: text("state").notNull().default("open"),
    response: text("response"),
    respondedBy: text("responded_by"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    cancelled: boolean("cancelled").notNull().default(false),
    cancelledReason: text("cancelled_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_attentions_target_open").on(table.targetHumanId, table.state),
    index("idx_attentions_chat_open").on(table.originChatId, table.state),
    index("idx_attentions_origin").on(table.originAgentId, table.createdAt),
  ],
);
