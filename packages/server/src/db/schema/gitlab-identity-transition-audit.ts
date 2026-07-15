import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { gitlabIdentityLinks } from "./gitlab-identity-links.js";
import { members } from "./members.js";
import { organizations } from "./organizations.js";

/** Append-only lifecycle history for an admin-managed GitLab identity link. */
export const gitlabIdentityTransitionAudit = pgTable(
  "gitlab_identity_transition_audit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    identityLinkId: text("identity_link_id")
      .notNull()
      .references(() => gitlabIdentityLinks.id, { onDelete: "cascade" }),
    /** Snapshots intentionally remain meaningful after connection replacement/deletion. */
    connectionId: text("connection_id"),
    instanceOrigin: text("instance_origin").notNull(),
    membershipId: text("membership_id").notNull(),
    displayUsername: text("display_username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    transition: text("transition").notNull(),
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_gitlab_identity_transition_org_created").on(table.organizationId, table.createdAt),
    index("idx_gitlab_identity_transition_link_created").on(table.identityLinkId, table.createdAt),
    check(
      "ck_gitlab_identity_transition",
      sql`${table.transition} IN ('created', 'suspended', 'reconfirmed', 'revoked', 'member_left', 'member_removed', 'connection_removed')`,
    ),
  ],
);
