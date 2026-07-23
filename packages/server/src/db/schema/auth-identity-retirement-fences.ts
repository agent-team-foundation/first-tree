import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Bounded provider-subject retirement fences.
 *
 * Identity and user references deliberately are not foreign keys: deleting
 * either source row must not erase the fence that rejects older OAuth work.
 */
export const authIdentityRetirementFences = pgTable(
  "auth_identity_retirement_fences",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    retiredIdentityId: text("retired_identity_id").notNull(),
    retiredUserId: text("retired_user_id").notNull(),
    retiredGeneration: bigint("retired_generation", { mode: "bigint" }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.provider, table.subject],
      name: "pk_auth_identity_retirement_fences",
    }),
    index("idx_auth_identity_retirement_fences_expiry").on(table.expiresAt),
    check("ck_auth_identity_retirement_fences_provider", sql`${table.provider} IN ('github', 'google')`),
    check("ck_auth_identity_retirement_fences_generation", sql`${table.retiredGeneration} >= 0`),
    check("ck_auth_identity_retirement_fences_expiry_order", sql`${table.expiresAt} > ${table.retiredAt}`),
  ],
);
