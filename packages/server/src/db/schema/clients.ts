import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
    /**
     * Soft-delete timestamp for orphan-row archival.
     *
     * - NULL  → active row. Surfaces in all read paths
     *   (`/me/clients`, `/orgs/:orgId/clients`, `GET /clients/:id`,
     *   `agent:bind` joins, onboarding inference).
     * - Non-NULL → archived (`archiveAbandonedClients` sweep judged this
     *   row abandoned: disconnected, >30 days unseen, zero pinned
     *   agents). Excluded from every read path but the row stays for
     *   audit / recovery (admin SQL `UPDATE clients SET archived_at =
     *   NULL WHERE id = '...'` resurrects).
     *
     * Soft-delete (not DELETE) so the dedup path can `pickCanonical` an
     * archived row when a re-registering CLI returns; the `(A)` same-id
     * upsert clears `archived_at` automatically on reconnect — see
     * `services/client.ts::registerClient`.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_clients_user").on(table.userId),
    index("idx_clients_org").on(table.organizationId),
    /**
     * Supports the hourly `archiveAbandonedClients` sweep — its WHERE
     * clause scans `(status='disconnected', last_seen_at < cutoff,
     * archived_at IS NULL)`. The partial predicate keeps the index small
     * (archived rows excluded) and a (status, last_seen_at) leading key
     * lines up with the equality + range predicate.
     */
    index("idx_clients_sweep").on(table.status, table.lastSeenAt).where(sql`archived_at IS NULL`),
  ],
);
