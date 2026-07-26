import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { gitlabConnections } from "./gitlab-connections.js";
import { gitlabIdentityLinks } from "./gitlab-identity-links.js";
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
    boundVia: text("bound_via").notNull().default("agent_declared"),
    identityLinkId: text("identity_link_id").references(() => gitlabIdentityLinks.id, { onDelete: "cascade" }),
    humanAgentId: text("human_agent_id").references(() => agents.uuid, { onDelete: "cascade" }),
    delegateAgentId: text("delegate_agent_id").references(() => agents.uuid, { onDelete: "cascade" }),
    attentionMode: text("attention_mode").notNull().default("legacy_route_only"),
    attentionBackfillVersion: integer("attention_backfill_version").notNull().default(0),
    active: boolean("active").notNull().default(true),
    entityType: text("entity_type").notNull(),
    entityIid: integer("entity_iid").notNull(),
    projectId: bigint("project_id", { mode: "number" }),
    projectPath: text("project_path").notNull(),
    projectPathNormalized: text("project_path_normalized").notNull(),
    entityUrl: text("entity_url").notNull(),
    title: text("title"),
    entityState: text("entity_state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_entity_pending_pair")
      .on(
        table.connectionId,
        table.humanAgentId,
        table.delegateAgentId,
        table.projectPathNormalized,
        table.entityType,
        table.entityIid,
      )
      .where(
        sql`${table.projectId} IS NULL AND ${table.active} AND ${table.boundVia} <> 'identity_target' AND ${table.humanAgentId} IS NOT NULL AND ${table.delegateAgentId} IS NOT NULL`,
      ),
    uniqueIndex("uq_gitlab_entity_observed_pair")
      .on(
        table.connectionId,
        table.humanAgentId,
        table.delegateAgentId,
        table.projectId,
        table.entityType,
        table.entityIid,
      )
      .where(
        sql`${table.projectId} IS NOT NULL AND ${table.active} AND ${table.boundVia} <> 'identity_target' AND ${table.humanAgentId} IS NOT NULL AND ${table.delegateAgentId} IS NOT NULL`,
      ),
    uniqueIndex("uq_gitlab_entity_pending_legacy_chat")
      .on(table.connectionId, table.chatId, table.projectPathNormalized, table.entityType, table.entityIid)
      .where(
        sql`${table.projectId} IS NULL AND ${table.active} AND ${table.boundVia} <> 'identity_target' AND ${table.humanAgentId} IS NULL AND ${table.delegateAgentId} IS NULL`,
      ),
    uniqueIndex("uq_gitlab_entity_observed_legacy_chat")
      .on(table.connectionId, table.chatId, table.projectId, table.entityType, table.entityIid)
      .where(
        sql`${table.projectId} IS NOT NULL AND ${table.active} AND ${table.boundVia} <> 'identity_target' AND ${table.humanAgentId} IS NULL AND ${table.delegateAgentId} IS NULL`,
      ),
    uniqueIndex("uq_gitlab_entity_identity_target")
      .on(table.connectionId, table.identityLinkId, table.projectId, table.entityType, table.entityIid)
      .where(sql`${table.projectId} IS NOT NULL AND ${table.active} AND ${table.boundVia} = 'identity_target'`),
    index("idx_gitlab_entity_observed_lookup").on(
      table.connectionId,
      table.projectId,
      table.entityType,
      table.entityIid,
    ),
    index("idx_gitlab_entity_pending_lookup")
      .on(table.connectionId, table.projectPathNormalized, table.entityType, table.entityIid)
      .where(sql`${table.projectId} IS NULL`),
    index("idx_gitlab_entity_chat").on(table.chatId),
    check("ck_gitlab_entity_type", sql`${table.entityType} IN ('issue', 'pull_request')`),
    check(
      "ck_gitlab_entity_bound_via",
      sql`${table.boundVia} IN ('agent_declared', 'human_declared', 'identity_target')`,
    ),
    check(
      "ck_gitlab_entity_identity_owner",
      sql`${table.boundVia} <> 'identity_target' OR (${table.identityLinkId} IS NOT NULL AND ${table.humanAgentId} IS NOT NULL AND ${table.delegateAgentId} IS NOT NULL AND ${table.projectId} IS NOT NULL)`,
    ),
    check(
      "ck_gitlab_entity_attention_pair",
      sql`(${table.humanAgentId} IS NULL AND ${table.delegateAgentId} IS NULL) OR (${table.humanAgentId} IS NOT NULL AND ${table.delegateAgentId} IS NOT NULL)`,
    ),
    check("ck_gitlab_entity_attention_mode", sql`${table.attentionMode} IN ('paired', 'legacy_route_only')`),
  ],
);
