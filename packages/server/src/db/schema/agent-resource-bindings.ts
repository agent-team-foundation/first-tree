import type { AgentResourceBindingMode, ResourceType } from "@first-tree/shared";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { resources } from "./resources.js";

export const agentResourceBindings = pgTable(
  "agent_resource_bindings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    type: text("type").$type<ResourceType>().notNull(),
    mode: text("mode").$type<AgentResourceBindingMode>().notNull(),
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "cascade" }),
    replacesResourceId: text("replaces_resource_id").references(() => resources.id, { onDelete: "cascade" }),
    inlinePromptBody: text("inline_prompt_body"),
    repoRef: text("repo_ref"),
    repoLocalPath: text("repo_local_path"),
    order: integer("order").notNull().default(0),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_resource_bindings_agent").on(table.agentId, table.type),
    index("idx_agent_resource_bindings_resource").on(table.resourceId),
    index("idx_agent_resource_bindings_replaces").on(table.replacesResourceId),
  ],
);
