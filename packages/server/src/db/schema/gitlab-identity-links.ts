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
    connectionId: text("connection_id")
      .notNull()
      .references(() => gitlabConnections.id, { onDelete: "cascade" }),
    displayUsername: text("display_username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_gitlab_identity_connection_membership").on(table.connectionId, table.membershipId),
    uniqueIndex("uq_gitlab_identity_connection_username").on(table.connectionId, table.normalizedUsername),
    index("idx_gitlab_identity_org_state").on(table.organizationId, table.state),
    index("idx_gitlab_identity_membership_state").on(table.membershipId, table.state),
    check("ck_gitlab_identity_state", sql`${table.state} IN ('active', 'suspended')`),
  ],
);
