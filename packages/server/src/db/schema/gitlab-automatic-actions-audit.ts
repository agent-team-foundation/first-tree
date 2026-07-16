import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { members } from "./members.js";
import { organizations } from "./organizations.js";

/** Append-only evidence that an admin accepted or withdrew the Team-wide URL bearer risk. */
export const gitlabAutomaticActionsAudit = pgTable(
  "gitlab_automatic_actions_audit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Snapshot identity: intentionally not an FK so connection hard-delete cannot erase the audit. */
    connectionId: text("connection_id").notNull(),
    instanceOrigin: text("instance_origin").notNull(),
    enabled: boolean("enabled").notNull(),
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_gitlab_automation_audit_org_created").on(table.organizationId, table.createdAt)],
);
