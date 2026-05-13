import type { NotificationSeverity, NotificationType } from "@agent-team-foundation/first-tree-hub-shared";
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    /**
     * Optional producer-supplied key used to suppress duplicate notifications
     * while a prior one is still unread. Examples: `agent:{uuid}:error`,
     * `chat:{uuid}:completed`. The partial unique index below scopes uniqueness
     * to `(organization_id, dedup_key)` rows where `read=false`, so a fresh
     * notification fires as soon as the user acknowledges the previous one.
     * Producers without a dedup_key keep the legacy always-insert behaviour.
     */
    dedupKey: text("dedup_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_notifications_org_created").on(table.organizationId, table.createdAt),
    index("idx_notifications_agent").on(table.agentId),
    index("idx_notifications_org_read").on(table.organizationId, table.read),
    uniqueIndex("uq_notifications_org_dedup_unread")
      .on(table.organizationId, table.dedupKey)
      .where(sql`read = false AND dedup_key IS NOT NULL`),
  ],
);
