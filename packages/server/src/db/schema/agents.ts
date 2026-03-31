import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Agent registration. Each agent owns a unique inboxId for message delivery. */
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().default("default"),
    /** "human" | "personal_assistant" | "autonomous_agent" */
    type: text("type").notNull(),
    displayName: text("display_name"),
    /** Agent ID to forward @mentions to (e.g. personal assistant) */
    delegateMention: text("delegate_mention"),
    /** Materialized path within members/ tree, e.g. "engineering/agent-a" */
    treePath: text("tree_path"),
    /** Delivery address, auto-generated as inbox_{id} */
    inboxId: text("inbox_id").unique().notNull(),
    /** "active" | "suspended". Suspended agents have all API requests rejected. */
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_agents_org").on(table.organizationId)],
);
