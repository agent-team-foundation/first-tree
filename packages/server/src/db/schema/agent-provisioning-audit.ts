import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { members } from "./members.js";
import { organizations } from "./organizations.js";

/** Immutable record of an agent-authorized provisioning operation. */
export const agentProvisioningAudit = pgTable(
  "agent_provisioning_audit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actingAgentId: text("acting_agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "restrict" }),
    managingMemberId: text("managing_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    createdAgentId: text("created_agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "restrict" }),
    chatId: text("chat_id"),
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_provisioning_audit_org_created").on(table.organizationId, table.createdAt),
    index("idx_agent_provisioning_audit_actor").on(table.actingAgentId, table.createdAt),
  ],
);
