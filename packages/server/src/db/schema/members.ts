import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Onboarding wizard progress, tracked per (user × workspace).
 *
 * Why per-membership and not per-user: a user already onboarded in workspace A
 * who is invited to workspace B should not re-walk the Connect Computer screen
 * — but the Create Agent screen still applies, since each workspace gets its
 * own first agent. See P0-5 in docs/saas-onboarding-journey.md §6.1.
 */
export type OnboardingState = {
  currentStep: "connect" | "create_agent" | "completed";
};

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
    /** Onboarding wizard checkpoint; null = not started. See type docs above. */
    onboardingState: jsonb("onboarding_state").$type<OnboardingState>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_members_user_org").on(table.userId, table.organizationId),
    index("idx_members_user").on(table.userId),
    index("idx_members_org").on(table.organizationId),
  ],
);
