import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Client connections. A client is a single SDK process (AgentRuntime) that may host multiple agents. */
export const clients = pgTable("clients", {
  id: text("id").primaryKey(),
  /** "connected" | "disconnected" */
  status: text("status").notNull().default("disconnected"),
  sdkVersion: text("sdk_version"),
  hostname: text("hostname"),
  os: text("os"),
  /** Server instance ID that holds this client's WebSocket connection */
  instanceId: text("instance_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
});
