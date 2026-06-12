import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
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
     * "active" | "left". Soft-delete marker. Members who leave a team have
     * their row flipped to "left" rather than deleted, so historical chats /
     * agent ownership references stay intact. The auth middleware refuses
     * tokens that resolve to a "left" member; the join-by-invite flow flips
     * a previously-"left" row back to "active".
     */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_members_user_org").on(table.userId, table.organizationId),
    index("idx_members_user").on(table.userId),
    index("idx_members_org").on(table.organizationId),
  ],
);
