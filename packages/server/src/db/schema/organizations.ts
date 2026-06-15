import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Organization entity. Agents and chats belong to exactly one organization. */
export const organizations = pgTable("organizations", {
  /** UUID v7 primary key, system-generated */
  id: text("id").primaryKey(),
  /** URL-friendly slug, unique across all organizations (e.g. "acme-corp") */
  name: text("name").unique().notNull(),
  displayName: text("display_name").notNull(),
  /** 0 = unlimited (self-hosted default) */
  maxAgents: integer("max_agents").notNull().default(0),
  /** 0 = unlimited */
  maxMessagesPerMinute: integer("max_messages_per_minute").notNull().default(0),
  /** "active" | "deleted". Deleted orgs are hidden from membership resolution. */
  status: text("status").notNull().default("active"),
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
