import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/** Organization membership. Links a user to an org with a role and a 1:1 human agent. */
export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** 1:1 human agent for this member in this org */
    agentId: text("agent_id")
      .unique()
      .notNull()
      .references(() => agents.uuid),
    /** "admin" | "member" */
    role: text("role").notNull(),
    /**
     * Per-membership onboarding auto-open suppressor. A user completing or
     * hiding onboarding in one org must not suppress setup for another org.
     */
    onboardingSuppressedAt: timestamp("onboarding_suppressed_at", { withTimezone: true }),
    /** "finish_later" | "completed" | "invitee_skip"; NULL iff onboardingSuppressedAt is NULL. */
    onboardingSuppressedReason: text("onboarding_suppressed_reason"),
    /** Audit stamp for completing this membership's onboarding journey. */
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    /**
     * "active" | "left" | "removed". Soft-delete marker. Members who leave
     * or are removed from a team keep their row so historical chats / agent
     * ownership references stay intact. Auth only accepts "active" rows.
     * Invite rejoin restores "left"; admin restore can restore "left" or
     * "removed".
     */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_members_user_org").on(table.userId, table.organizationId),
    index("idx_members_user").on(table.userId),
    index("idx_members_org").on(table.organizationId),
    /**
     * Onboarding completion implies suppression. Every completion path writes
     * `onboarding_completed_at` AND `onboarding_suppressed_at` (reason="completed")
     * together — the audit stamp and the redirect-gate move as one. This check
     * makes that invariant a schema fact instead of an app-layer convention, so a
     * future write that stamps completion without suppression (the class of bug
     * migration 0062 fixed) fails closed rather than silently stranding the user.
     */
    check(
      "ck_members_completed_implies_suppressed",
      sql`${table.onboardingCompletedAt} IS NULL OR ${table.onboardingSuppressedAt} IS NOT NULL`,
    ),
  ],
);
