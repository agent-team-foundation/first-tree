import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/** Agent online status. Tracked via WebSocket connections; stale entries are cleaned up using server_instances heartbeat. */
export const agentPresence = pgTable("agent_presence", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.uuid, { onDelete: "cascade" }),
  /** "online" | "offline" */
  status: text("status").notNull().default("offline"),
  /** Server instance ID that holds this agent's WebSocket connection */
  instanceId: text("instance_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
