import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().default("default"),
    type: text("type").notNull(),
    displayName: text("display_name"),
    inboxId: text("inbox_id").unique().notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_agents_org").on(table.organizationId)],
);
