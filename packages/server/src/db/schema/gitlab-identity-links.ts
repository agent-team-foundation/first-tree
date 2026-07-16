import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gitlabConnections } from "./gitlab-connections.js";
import { members } from "./members.js";
import { organizations } from "./organizations.js";

/** Admin-managed, org-local GitLab username → current membership link. */
export const gitlabIdentityLinks = pgTable(
  "gitlab_identity_links",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    /** Null after the bound connection is replaced/deleted; instanceOrigin preserves the audit snapshot. */
    connectionId: text("connection_id").references(() => gitlabConnections.id, { onDelete: "set null" }),
    instanceOrigin: text("instance_origin").notNull(),
    displayUsername: text("display_username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    state: text("state").notNull(),
    stateReason: text("state_reason"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    confirmedByMemberId: text("confirmed_by_member_id").references(() => members.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    suspendedByMemberId: text("suspended_by_member_id").references(() => members.id, { onDelete: "set null" }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    revokedByMemberId: text("revoked_by_member_id").references(() => members.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_identity_active_membership")
      .on(table.connectionId, table.membershipId)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex("uq_gitlab_identity_active_username")
      .on(table.connectionId, table.normalizedUsername)
      .where(sql`${table.state} = 'active'`),
    index("idx_gitlab_identity_org_state").on(table.organizationId, table.state),
    index("idx_gitlab_identity_membership_state").on(table.membershipId, table.state),
    check("ck_gitlab_identity_state", sql`${table.state} IN ('active', 'suspended', 'revoked')`),
    check("ck_gitlab_identity_active_connection", sql`${table.state} <> 'active' OR ${table.connectionId} IS NOT NULL`),
  ],
);
