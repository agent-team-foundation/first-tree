import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Org-level invitation links. v1 enforces "one active link per org" via a
 * partial UNIQUE index added in the SQL migration (Drizzle's TS DSL does not
 * yet model partial uniques). Rotating a link sets `revoked_at` on the prior
 * row and inserts a new one in the same transaction; revoked rows stay for
 * audit but no longer satisfy the partial uniqueness predicate.
 *
 * `role` is fixed to `'member'` by the v1 API but stored on the row so a
 * future "invite as admin" feature is a route change, not a schema change.
 *
 * `expires_at` is left unset by the v1 rotate flow — invite links don't
 * auto-expire. The column exists so an admin can opt into expiry later (and
 * the partial unique predicate already filters on it).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** URL-safe random token (32 raw bytes → 43-char base64url). */
    token: text("token").notNull().unique(),
    /** v1: always "member". Schema permits "admin" for v2. */
    role: text("role").notNull().default("member"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_invitations_token").on(table.token), index("idx_invitations_org").on(table.organizationId)],
);

/** Audit row for every successful redemption — v1 admins inspect via DB. */
export const invitationRedemptions = pgTable(
  "invitation_redemptions",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("idx_invitation_redemptions_invitation").on(table.invitationId),
    index("idx_invitation_redemptions_user").on(table.userId),
  ],
);
