import { jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/** Maps external user identities to internal Agents. */
export const adapterAgentMappings = pgTable(
  "adapter_agent_mappings",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(),
    externalUserId: text("external_user_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** "code" | "reverse_token" | "oauth" | "manual" */
    boundVia: text("bound_via"),
    displayName: text("display_name"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_adapter_agent_mapping").on(table.platform, table.externalUserId)],
);
