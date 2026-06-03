import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { organizations } from "./organizations.js";

/**
 * Durable Context Tree IO facts. Each row means an agent actively read or
 * wrote first-tree-context repo content in a chat-scoped runtime session.
 *
 * `source_session_event_id` intentionally has no FK to `session_events`:
 * session timeline rows are cleared on eviction/termination, while this table
 * is the longer-lived statistics source.
 */
export const contextTreeIoEvents = pgTable(
  "context_tree_io_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    sourceSessionEventId: text("source_session_event_id").notNull(),
    sourceIndex: integer("source_index").notNull().default(0),
    runtimeProvider: text("runtime_provider").notNull(),
    action: text("action").notNull(),
    source: text("source").notNull(),
    treeRepoUrl: text("tree_repo_url").notNull(),
    treeBranch: text("tree_branch").notNull(),
    targetKind: text("target_kind").notNull(),
    targetPath: text("target_path").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_context_tree_io_source").on(table.sourceSessionEventId, table.sourceIndex),
    index("idx_context_tree_io_org_recent").on(table.organizationId, table.createdAt.desc()),
    index("idx_context_tree_io_org_action_recent").on(table.organizationId, table.action, table.createdAt.desc()),
    index("idx_context_tree_io_org_agent_recent").on(table.organizationId, table.agentId, table.createdAt.desc()),
    index("idx_context_tree_io_org_target_recent").on(table.organizationId, table.targetPath, table.createdAt.desc()),
    check("ck_context_tree_io_action", sql`${table.action} IN ('read', 'write')`),
    check("ck_context_tree_io_target_kind", sql`${table.targetKind} IN ('file', 'directory', 'repo')`),
    check("ck_context_tree_io_target_path_nonempty", sql`${table.targetPath} <> ''`),
  ],
);
