import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gitlabConnections } from "./gitlab-connections.js";
import { organizations } from "./organizations.js";

/** Connection-scoped, inbound-only GitLab entity identity/projection source of truth. */
export const gitlabEntities = pgTable(
  "gitlab_entities",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => gitlabConnections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityIid: integer("entity_iid").notNull(),
    projectId: bigint("project_id", { mode: "number" }).notNull(),
    projectPath: text("project_path").notNull(),
    projectPathNormalized: text("project_path_normalized").notNull(),
    entityUrl: text("entity_url").notNull(),
    title: text("title"),
    entityState: text("entity_state").notNull().default("open"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_entity_numeric_identity").on(
      table.connectionId,
      table.projectId,
      table.entityType,
      table.entityIid,
    ),
    uniqueIndex("uq_gitlab_entity_current_path").on(
      table.connectionId,
      table.projectPathNormalized,
      table.entityType,
      table.entityIid,
    ),
    index("idx_gitlab_entity_connection").on(table.connectionId),
    check("ck_gitlab_entities_type", sql`${table.entityType} IN ('issue', 'pull_request')`),
  ],
);
