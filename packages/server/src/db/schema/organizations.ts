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
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  /**
   * Optional context-tree GitHub URL bound to this organization. Set during
   * Step 3 onboarding (either by the user pasting an existing tree URL, or
   * by the agent reporting a freshly-created tree's URL via
   * `first-tree-hub org bind-tree`). Null until the user finishes Step 3
   * or skips onboarding entirely. Hub treats this as a cache — the
   * source-of-truth binding lives in each source repo's
   * `.first-tree/local-tree.json`; this column lets onboarding UI and future
   * agent spawns know about the tree without re-reading every source repo.
   */
  treeUrl: text("tree_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
