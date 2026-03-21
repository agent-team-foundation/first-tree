import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentPresence = pgTable("agent_presence", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("offline"),
  instanceId: text("instance_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
