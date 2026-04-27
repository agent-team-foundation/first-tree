import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** User accounts. Passwords are stored as bcrypt hashes. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  /**
   * Primary contact email. Sourced from the GitHub OAuth provider for SaaS
   * users; legacy self-hosted rows are backfilled with a `<id>@noreply.local`
   * placeholder by migration 0026 and updated when the user later links a
   * provider. UNIQUE NOT NULL — see docs/saas-onboarding-journey.md §5.1.
   */
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  /** "active" | "suspended" */
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
