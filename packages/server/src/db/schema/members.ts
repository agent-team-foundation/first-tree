import type { OnboardingState } from "@agent-team-foundation/first-tree-hub-shared";
import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
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
     * Onboarding wizard checkpoint; null = not started. Per (user × workspace)
     * so a user already onboarded in workspace A skips the Connect screen
     * when invited to workspace B (P0-5). Shape is the canonical
     * `OnboardingState` type from `@agent-team-foundation/first-tree-hub-shared`.
     */
    onboardingState: jsonb("onboarding_state").$type<OnboardingState>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_members_user_org").on(table.userId, table.organizationId),
    index("idx_members_user").on(table.userId),
    index("idx_members_org").on(table.organizationId),
  ],
);
