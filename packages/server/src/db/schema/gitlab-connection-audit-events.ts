import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { gitlabConnections } from "./gitlab-connections.js";

/** Append-only administrator lifecycle evidence for URL bearer and automation-risk decisions. */
export const gitlabConnectionAuditEvents = pgTable(
  "gitlab_connection_audit_events",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => gitlabConnections.id, { onDelete: "cascade" }),
    /** Immutable actor identifier; intentionally not FK-nullified when membership later leaves. */
    actorMemberId: text("actor_member_id"),
    event: text("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_gitlab_connection_audit_connection").on(table.connectionId, table.createdAt)],
);
