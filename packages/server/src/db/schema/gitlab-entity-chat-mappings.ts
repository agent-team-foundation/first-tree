import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { gitlabConnections } from "./gitlab-connections.js";
import { gitlabEntities } from "./gitlab-entities.js";
import { organizations } from "./organizations.js";

export const gitlabEntityChatMappings = pgTable(
  "gitlab_entity_chat_mappings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => gitlabConnections.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    declaredByAgentId: text("declared_by_agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityIid: integer("entity_iid").notNull(),
    entityId: text("entity_id").references(() => gitlabEntities.id, { onDelete: "cascade" }),
    projectId: bigint("project_id", { mode: "number" }),
    projectPath: text("project_path").notNull(),
    projectPathNormalized: text("project_path_normalized").notNull(),
    entityUrl: text("entity_url").notNull(),
    title: text("title"),
    entityState: text("entity_state").notNull().default("open"),
    status: text("status").notNull().default("pending"),
    lastConflictAt: timestamp("last_conflict_at", { withTimezone: true }),
    lastConflictReason: text("last_conflict_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_entity_pending_chat")
      .on(table.connectionId, table.chatId, table.projectPathNormalized, table.entityType, table.entityIid)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("uq_gitlab_entity_observed_chat")
      .on(table.connectionId, table.chatId, table.entityId)
      .where(sql`${table.entityId} IS NOT NULL`),
    index("idx_gitlab_entity_observed_lookup").on(
      table.connectionId,
      table.projectId,
      table.entityType,
      table.entityIid,
    ),
    index("idx_gitlab_entity_chat").on(table.chatId),
    check("ck_gitlab_entity_type", sql`${table.entityType} IN ('issue', 'pull_request')`),
    check("ck_gitlab_entity_status", sql`${table.status} IN ('pending', 'observed')`),
  ],
);
