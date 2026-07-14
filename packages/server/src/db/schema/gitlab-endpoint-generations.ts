import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gitlabConnections } from "./gitlab-connections.js";

export const gitlabEndpointGenerations = pgTable(
  "gitlab_endpoint_generations",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => gitlabConnections.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    /** SHA-256(base64url) of the URL bearer. The bearer itself is never persisted. */
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_endpoint_token_hash").on(table.tokenHash),
    uniqueIndex("uq_gitlab_endpoint_generation").on(table.connectionId, table.generation),
    uniqueIndex("uq_gitlab_endpoint_current").on(table.connectionId).where(sql`${table.status} = 'current'`),
    uniqueIndex("uq_gitlab_endpoint_previous").on(table.connectionId).where(sql`${table.status} = 'previous'`),
    index("idx_gitlab_endpoint_connection").on(table.connectionId),
    check("ck_gitlab_endpoint_status", sql`${table.status} IN ('current', 'previous', 'revoked')`),
  ],
);
