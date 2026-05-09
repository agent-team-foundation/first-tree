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
  /**
   * Set when the user clicks `✕` on the onboarding stepper. Decoupled from
   * `onboardingStep` so the stepper can keep rendering across all three
   * UI steps (server-side onboardingStep flips to `completed` at the end of
   * Step 2 — Step 3 is purely client-driven). NULL = stepper renders.
   * See docs/new-user-onboarding-design.md §8.
   */
  onboardingDismissedAt: timestamp("onboarding_dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
