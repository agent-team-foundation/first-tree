import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Admin accounts. Passwords are stored as bcrypt hashes. */
export const adminUsers = pgTable("admin_users", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  /** "super_admin" | "admin" */
  role: text("role").notNull().default("admin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});
