import type {
  ResourceDefaultEnabled,
  ResourcePayload,
  ResourceScope,
  ResourceStatus,
  ResourceType,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").$type<ResourceType>().notNull(),
    scope: text("scope").$type<ResourceScope>().notNull(),
    ownerAgentId: text("owner_agent_id").references(() => agents.uuid, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repoCanonicalKey: text("repo_canonical_key"),
    defaultEnabled: text("default_enabled").$type<ResourceDefaultEnabled>(),
    status: text("status").$type<ResourceStatus>().notNull().default("active"),
    payload: jsonb("payload").$type<ResourcePayload>().notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_resources_org_type_scope").on(table.organizationId, table.type, table.scope),
    index("idx_resources_owner_agent").on(table.ownerAgentId),
    index("idx_resources_repo_key").on(table.organizationId, table.repoCanonicalKey),
    uniqueIndex("uq_resources_team_repo_canonical_active")
      .on(table.organizationId, table.repoCanonicalKey)
      .where(
        sql`${table.type} = 'repo' AND ${table.scope} = 'team' AND ${table.status} IN ('active', 'stale') AND ${table.repoCanonicalKey} IS NOT NULL`,
      ),
    uniqueIndex("uq_resources_agent_repo_canonical_active")
      .on(table.organizationId, table.ownerAgentId, table.repoCanonicalKey)
      .where(
        sql`${table.type} = 'repo' AND ${table.scope} = 'agent' AND ${table.status} IN ('active', 'stale') AND ${table.repoCanonicalKey} IS NOT NULL`,
      ),
  ],
);
