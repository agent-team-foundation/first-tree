import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Client connections. A client is a single SDK process (AgentRuntime) that may
 * host multiple agents. From the unified-user-token milestone on, a client is
 * owned by a user — Rule R-RUN requires `clients.user_id == jwt.userId` for
 * every `agent:bind` request. `user_id` is nullable only to accommodate legacy
 * rows created before JWT-on-handshake; the WS handshake claims the row on
 * first re-register under an authenticated JWT (see `client:register` M13).
 *
 * A client is also bound to exactly one organization for its lifetime. The
 * `organization_id` column is populated on first registration from the
 * authenticated JWT's org claim and never changes thereafter. Re-registering
 * the same clientId under a JWT for a different org is rejected with
 * `CLIENT_ORG_MISMATCH` — the CLI responds by abandoning the local clientId
 * and registering a new one instead (see first-tree-context:agent-hub/multi-tenancy.md).
 */
export const clients = pgTable(
  "clients",
  {
    id: text("id").primaryKey(),
    /** Owning user. Nullable for legacy rows; runtime bind refuses when NULL. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Org this client is bound to. Set at first registration, immutable. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** "connected" | "disconnected"; retired clients keep disconnected here and carry retiredAt. */
    status: text("status").notNull().default("disconnected"),
    sdkVersion: text("sdk_version"),
    hostname: text("hostname"),
    os: text("os"),
    /** Server instance ID that holds this client's WebSocket connection */
    instanceId: text("instance_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Tombstone marker for client identities retired through Settings / logout --purge. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /**
     * Optional Client-reported pause reason from the existing heartbeat frame
     * (`auth_rejected` | `auth_refresh_failed`). Null when healthy. Cron
     * dispatchability treats a non-null value as `client_paused`.
     */
    pausedReason: text("paused_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_clients_user").on(table.userId),
    index("idx_clients_org").on(table.organizationId),
    check(
      "ck_clients_paused_reason",
      sql`${table.pausedReason} IS NULL OR ${table.pausedReason} IN ('auth_rejected', 'auth_refresh_failed')`,
    ),
  ],
);
