import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { members } from "./members.js";
import { organizations } from "./organizations.js";

export const gitlabConnections = pgTable(
  "gitlab_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** Display/identity data only. The Cloud server must never fetch this origin. */
    instanceOrigin: text("instance_origin").notNull(),
    active: boolean("active").notNull().default(true),
    /** Accepts inbound Test/events but suppresses card delivery until admin completes recovery. */
    recoveryPending: boolean("recovery_pending").notNull().default(false),
    automaticActionsEnabled: boolean("automatic_actions_enabled").notNull().default(false),
    automaticActionsAcceptedAt: timestamp("automatic_actions_accepted_at", { withTimezone: true }),
    automaticActionsAcceptedByMemberId: text("automatic_actions_accepted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    reviewerMode: text("reviewer_mode").notNull().default("unknown"),
    lastValidInboundAt: timestamp("last_valid_inbound_at", { withTimezone: true }),
    lastProcessingFailureAt: timestamp("last_processing_failure_at", { withTimezone: true }),
    lastProcessingFailureCode: text("last_processing_failure_code"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledMode: text("disabled_mode"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_gitlab_connections_org").on(table.organizationId),
    check("ck_gitlab_connections_reviewer_mode", sql`${table.reviewerMode} IN ('unknown', 'assignee', 'reviewers')`),
    check(
      "ck_gitlab_connections_disabled_mode",
      sql`${table.disabledMode} IS NULL OR ${table.disabledMode} IN ('normal', 'incident')`,
    ),
  ],
);
