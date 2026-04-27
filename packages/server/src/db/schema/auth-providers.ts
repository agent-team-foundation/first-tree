import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Third-party identity bindings (GitHub today, Google/Feishu future).
 *
 * One row per (provider, provider_user_id) pair — joining a provider account
 * to a `users.id`. Lookup path on OAuth callback:
 *   1. find row by (provider, provider_user_id)
 *   2. if hit -> reuse user; if miss -> create user + this row in a tx.
 *
 * `email_at_link` snapshots the email returned by the provider at link time
 * (audit only). The current email of record lives on `users.email`.
 *
 * See docs/saas-onboarding-journey.md §5.2.
 */
export const authProviders = pgTable(
  "auth_providers",
  {
    /** UUID v7, system-generated. Callers must supply via `uuidv7()` at insert time — matches the convention used by `users` and `organizations`. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "github" today; future: "google" | "feishu" */
    provider: text("provider").notNull(),
    /** Provider's stable opaque user ID (e.g. GitHub numeric ID as string). */
    providerUserId: text("provider_user_id").notNull(),
    /** Email returned by the provider at link time (audit only, may go stale). */
    emailAtLink: text("email_at_link"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_auth_providers_provider_user").on(table.provider, table.providerUserId),
    index("idx_auth_providers_user").on(table.userId),
  ],
);
