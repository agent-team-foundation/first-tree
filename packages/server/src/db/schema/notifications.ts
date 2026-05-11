import type { NotificationSeverity, NotificationType } from "@agent-team-foundation/first-tree-hub-shared";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Notifications — M1 event notifications for admin dashboard.
 * Referential integrity (org / agent / chat) is enforced at the service layer,
 * not via DB foreign keys.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    type: text("type").$type<NotificationType>().notNull(),
    severity: text("severity").$type<NotificationSeverity>().notNull(),
    agentId: text("agent_id"),
    chatId: text("chat_id"),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_notifications_org_created").on(table.organizationId, table.createdAt),
    index("idx_notifications_agent").on(table.agentId),
    index("idx_notifications_org_read").on(table.organizationId, table.read),
  ],
);
