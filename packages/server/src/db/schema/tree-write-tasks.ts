import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Archive-triggered Context Tree write tasks.
 *
 * The row is the machine contract between:
 *   1. archive trigger (`active -> archived`)
 *   2. background worker / lease management
 *   3. client-runtime execution result (`task:tree_write:result`)
 *
 * Service-layer integrity only. The source chat, owner user, and target agent
 * are resolved by the trigger path; no hard foreign keys so retries / DLQ
 * bookkeeping stay decoupled from unrelated lifecycle deletes.
 */
export const treeWriteTasks = pgTable(
  "tree_write_tasks",
  {
    id: text("id").primaryKey(),
    sourceChatId: text("source_chat_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    archiveSeq: integer("archive_seq").notNull(),
    agentId: text("agent_id").notNull(),
    state: text("state").notNull().default("pending"),
    execChatId: text("exec_chat_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    resultKind: text("result_kind"),
    resultPayload: jsonb("result_payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_tree_write_tasks_source_owner_archive").on(table.sourceChatId, table.ownerUserId, table.archiveSeq),
    index("idx_tree_write_tasks_state_next_attempt").on(table.state, table.nextAttemptAt),
    index("idx_tree_write_tasks_agent").on(table.agentId),
    index("idx_tree_write_tasks_source_chat").on(table.sourceChatId),
  ],
);
