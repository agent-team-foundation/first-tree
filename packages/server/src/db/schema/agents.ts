import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { clients } from "./clients.js";
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
    /**
     * Required human-readable label. Defaulted to `name` (or "Unnamed Agent"
     * when both would be null) on create by the service layer — see Phase 2
     * of the agent-naming refactor. Tombstoned rows (status="deleted") keep
     * whatever value they had; only `name` is nulled on delete.
     */
    displayName: text("display_name").notNull(),
    /** Agent UUID to forward @mentions to (e.g. personal assistant) */
    delegateMention: text("delegate_mention"),
    /** Delivery address, auto-generated as inbox_{uuid} */
    inboxId: text("inbox_id").unique().notNull(),
    /** "active" | "suspended" | "deleted". Suspended agents have all API requests rejected. */
    status: text("status").notNull().default("active"),
    /** How this agent was created: "admin-api" | "portal" */
    source: text("source"),
    /** Agent visibility: "private" (manager only) or "organization" (all members) */
    visibility: text("visibility").notNull().default("private"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Member who manages this agent (NOT NULL after 0019 unified-user-token migration) */
    managerId: text("manager_id").notNull(),
    /**
     * Physical client this agent is pinned to. Nullable for human agents (no
     * runtime). For non-human agents this used to be immutable (Rule R-RUN);
     * post-0026 it is re-bindable via `agentService.rebindAgent`, which runs
     * owner / org / capability checks atomically.
     */
    clientId: text("client_id").references(() => clients.id, { onDelete: "restrict" }),
    /**
     * Runtime provider that drives this agent (e.g. `"claude-code"`, `"codex"`).
     * NOT NULL; defaults to `"claude-code"` for backward compatibility with
     * rows created before 0026.
     */
    runtimeProvider: text("runtime_provider").notNull().default("claude-code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agents_org").on(table.organizationId),
    index("idx_agents_manager").on(table.managerId),
    index("idx_agents_visibility_org").on(table.organizationId, table.visibility),
    index("idx_agents_client").on(table.clientId),
    unique("uq_agents_org_name").on(table.organizationId, table.name),
  ],
);
