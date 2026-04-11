import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { organizations } from "./organizations.js";

/**
 * Tasks — lightweight work units. Process descriptors, not tickets.
 * Immutable status state machine: pending → assigned → working → (completed | failed | cancelled).
 * Sub-tasks (parent_task_id) are deferred to a later phase.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** "pending" | "assigned" | "working" | "completed" | "failed" | "cancelled" */
    status: text("status").notNull(),
    /** Assignee agent UUID; null when pending awaiting assignment. No FK so soft-deleted agents don't orphan tasks. */
    assigneeAgentId: text("assignee_agent_id"),
    /** Creator type: "agent" | "admin". Determines which ID space created_by_id lives in. */
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    /** Optional external reference (e.g. "owner/repo#123"). Pure record, not actionable. */
    originRef: text("origin_ref"),
    /** Agent-produced result (markdown). Populated on completion. */
    result: text("result"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByType: text("cancelled_by_type"),
    cancelledById: text("cancelled_by_id"),
  },
  (table) => [
    index("idx_tasks_org_status").on(table.organizationId, table.status),
    index("idx_tasks_assignee_status").on(table.assigneeAgentId, table.status),
    index("idx_tasks_origin_ref").on(table.originRef),
    index("idx_tasks_created_at").on(table.createdAt),
  ],
);

/**
 * Task ↔ Chat association (M:N). A task may be executed across multiple chats;
 * a chat may host work for multiple tasks over its lifetime.
 */
export const taskChats = pgTable(
  "task_chats",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** Who linked the chat — typically the agent reporting the association. */
    linkedByAgentId: text("linked_by_agent_id").references(() => agents.uuid),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.chatId] }), index("idx_task_chats_chat").on(table.chatId)],
);
