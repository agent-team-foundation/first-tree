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
  /** Number of active sessions (materialized from agent_chat_sessions) */
  activeSessions: integer("active_sessions"),
  /** Total sessions including suspended/evicted (materialized from agent_chat_sessions) */
  totalSessions: integer("total_sessions"),
  /** When runtime_state was last updated */
  runtimeUpdatedAt: timestamp("runtime_updated_at", { withTimezone: true }),
  /** Repo URL the client runtime resolved for this agent's Context Tree binding. */
  contextTreeRepoUrl: text("context_tree_repo_url"),
  /** Branch the client runtime resolved for this agent's Context Tree binding. */
  contextTreeBranch: text("context_tree_branch"),
  /** Client-reported verification status for the resolved Context Tree binding. */
  contextTreeVerificationStatus: text("context_tree_verification_status"),
  /** When the client last reported Context Tree binding status. */
  contextTreeUpdatedAt: timestamp("context_tree_updated_at", { withTimezone: true }),
});
