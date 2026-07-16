import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Seven-day operator view of personnel targets that failed closed. */
export const gitlabSkippedTargetAudit = pgTable(
  "gitlab_skipped_target_audit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Snapshot identity: retained for the bounded window after connection hard-delete. */
    connectionId: text("connection_id").notNull(),
    entityKey: text("entity_key").notNull(),
    targetClass: text("target_class").notNull(),
    externalUsername: text("external_username").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_gitlab_skipped_target_org_created").on(table.organizationId, table.createdAt),
    check("ck_gitlab_skipped_target_class", sql`${table.targetClass} IN ('reviewer', 'assignee', 'mention')`),
    check(
      "ck_gitlab_skipped_target_reason",
      sql`${table.reason} IN ('automatic_actions_disabled', 'reviewer_mode_unconfirmed', 'review_target_schema_anomaly', 'identity_not_found', 'identity_not_active', 'membership_not_active', 'delegate_missing', 'delegate_ineligible')`,
    ),
  ],
);
