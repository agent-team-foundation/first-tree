import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Monotonic OAuth kickoff authority for each supported identity provider.
 *
 * Rows are intentionally seeded during the later route cutover rather than by
 * this behavior-neutral schema slice. Authority consumers must fail closed if
 * a provider head is absent.
 */
export const authIdentityProviderHeads = pgTable(
  "auth_identity_provider_heads",
  {
    provider: text("provider").primaryKey(),
    generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ck_auth_identity_provider_heads_provider", sql`${table.provider} IN ('github', 'google')`),
    check("ck_auth_identity_provider_heads_generation", sql`${table.generation} >= 0`),
  ],
);
