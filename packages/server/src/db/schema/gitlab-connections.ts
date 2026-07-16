import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    /** SHA-256(base64url) of the only active URL bearer. The bearer itself is never persisted. */
    tokenHash: text("token_hash").notNull(),
    /** First valid inbound request observed for the current bearer. Reset on regeneration. */
    endpointFirstSeenAt: timestamp("endpoint_first_seen_at", { withTimezone: true }),
    lastValidInboundAt: timestamp("last_valid_inbound_at", { withTimezone: true }),
    lastProcessingFailureAt: timestamp("last_processing_failure_at", { withTimezone: true }),
    lastProcessingFailureCode: text("last_processing_failure_code"),
    stableDeliveryObservedAt: timestamp("stable_delivery_observed_at", { withTimezone: true }),
    /** Most recent syntactically valid GitLab version declared by webhook User-Agent. */
    lastObservedVersion: text("last_observed_version"),
    reviewerMode: text("reviewer_mode").notNull().default("unknown"),
    lastReviewerSchemaAnomalyAt: timestamp("last_reviewer_schema_anomaly_at", { withTimezone: true }),
    lastReviewerSchemaAnomalyCode: text("last_reviewer_schema_anomaly_code"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    updatedByMemberId: text("updated_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_connections_org").on(table.organizationId),
    uniqueIndex("uq_gitlab_connections_token_hash").on(table.tokenHash),
    check("ck_gitlab_connections_reviewer_mode", sql`${table.reviewerMode} IN ('unknown', 'assignee', 'reviewers')`),
  ],
);
