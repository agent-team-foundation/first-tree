import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
// NOTE: members FK is deferred — added via raw SQL in migration to avoid circular import

/** Agent registration. Each agent owns a unique inboxId for message delivery. */
export const agents = pgTable(
  "agents",
  {
    uuid: text("uuid").primaryKey(),
    /** Human-readable identifier. UNIQUE per org. NULL when deleted (releases the name). */
    name: text("name"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** "human" | "personal_assistant" | "autonomous_agent" */
    type: text("type").notNull(),
    displayName: text("display_name"),
    /** Agent UUID to forward @mentions to (e.g. personal assistant) */
    delegateMention: text("delegate_mention"),
    /** Agent self-description and instructions (markdown) */
    profile: text("profile"),
    /** Delivery address, auto-generated as inbox_{uuid} */
    inboxId: text("inbox_id").unique().notNull(),
    /** "active" | "suspended" | "deleted". Suspended agents have all API requests rejected. */
    status: text("status").notNull().default("active"),
    /** How this agent was created: "admin-api" | "bootstrap" | "portal" */
    source: text("source"),
    /** Control-plane user association (nullable, cloud-only) */
    cloudUserId: text("cloud_user_id"),
    /** Agent visibility: "private" (manager only) or "organization" (all members) */
    visibility: text("visibility").notNull().default("private"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Member who manages this agent (nullable — unassigned agents visible only to admins) */
    managerId: text("manager_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agents_org").on(table.organizationId),
    index("idx_agents_manager").on(table.managerId),
    index("idx_agents_visibility_org").on(table.organizationId, table.visibility),
    unique("uq_agents_org_name").on(table.organizationId, table.name),
  ],
);
