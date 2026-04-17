import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Client connections. A client is a single SDK process (AgentRuntime) that may
 * host multiple agents. From the unified-user-token milestone on, a client is
 * owned by a user — Rule R-RUN requires `clients.user_id == jwt.userId` for
 * every `agent:bind` request. `user_id` is nullable only to accommodate legacy
 * rows created before JWT-on-handshake; the WS handshake claims the row on
 * first re-register under an authenticated JWT (see `client:register` M13).
 */
export const clients = pgTable(
  "clients",
  {
    id: text("id").primaryKey(),
    /** Owning user. Nullable for legacy rows; runtime bind refuses when NULL. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
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
  },
  (table) => [index("idx_clients_user").on(table.userId)],
);
