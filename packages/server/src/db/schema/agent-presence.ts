import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { clients } from "./clients.js";

/** Agent presence and runtime state. Tracked via WebSocket connections; stale entries are cleaned up using server_instances heartbeat. */
export const agentPresence = pgTable("agent_presence", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.uuid, { onDelete: "cascade" }),
  /** Legacy: "online" | "offline". Kept for backward compat; runtime_state is the authority for M1+. */
  status: text("status").notNull().default("offline"),
  /** Server instance ID that holds this agent's WebSocket connection (migrating to clients table) */
  instanceId: text("instance_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

  // -- M1: Client & Runtime fields --

  /** FK to clients table. Non-null = agent is bound to a running client. */
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  /** Runtime type: "claude-code" | "codex" | "devin" | "custom" etc. */
  runtimeType: text("runtime_type"),
  /** Runtime version. */
  runtimeVersion: text("runtime_version"),
  /** idle | working | error. NULL = agent not running. THE authority for whether agent is running. */
  runtimeState: text("runtime_state"),
  /** Human-readable description of current work */
  runtimeDescription: text("runtime_description"),
  /** Number of active sessions */
  activeSessions: integer("active_sessions"),
  /** Total sessions (including suspended/evicted) */
  totalSessions: integer("total_sessions"),
  /** Error summary when runtime_state = "error" */
  errorMessage: text("error_message"),
  /** External task reference (e.g. GitHub Issue URL) */
  taskRef: text("task_ref"),
  /** When runtime_state was last updated */
  runtimeUpdatedAt: timestamp("runtime_updated_at", { withTimezone: true }),
});
