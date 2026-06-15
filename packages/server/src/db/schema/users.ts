import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** User accounts. Passwords are stored as bcrypt hashes. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  /** "active" | "suspended" */
  status: text("status").notNull().default("active"),
  // NOTE: the account-level `onboarding_dismissed_at` / `onboarding_completed_at`
  // columns were retired here — per-membership onboarding state now lives on
  // `members` (`onboarding_suppressed_at` / `onboarding_suppressed_reason` /
  // `onboarding_completed_at`). Migration 0062 stopped writing the user-level
  // columns; nothing has read them since (the `/me` payload sources these from
  // the membership row), so they are dropped to remove the dead-state foot-gun.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
