import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { members } from "./members.js";
import { messages } from "./messages.js";

/**
 * Scheduled jobs (cron). Thin message-materialization config: at due time the
 * Server writes one ordinary addressed message into `control_chat_id`.
 *
 * Fifteen columns only — see the accepted cronjobs V1 design. Fail-closed
 * stops are `state=paused` with a `state_reason`; there is no soft delete or
 * run history table. `last_trigger_message_id` is the backlog cursor; ACK does
 * not clear it.
 */
export const cronJobs = pgTable(
  "cron_jobs",
  {
    id: text("id").primaryKey(),
    ownerMemberId: text("owner_member_id")
      .notNull()
      .references(() => members.id),
    controlChatId: text("control_chat_id")
      .notNull()
      .references(() => chats.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    name: text("name").notNull(),
    /** V1 check only `reuse_control_chat`; future may add `new_chat_per_run`. */
    chatMode: text("chat_mode").notNull().default("reuse_control_chat"),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull(),
    prompt: text("prompt").notNull(),
    /** `active` | `paused` */
    state: text("state").notNull(),
    stateReason: text("state_reason"),
    revision: integer("revision").notNull().default(1),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastTriggerMessageId: text("last_trigger_message_id").references(() => messages.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_cron_jobs_control_agent_name").on(table.controlChatId, table.agentId, table.name),
    index("idx_cron_jobs_due").on(table.nextRunAt, table.id).where(sql`${table.state} = 'active'`),
    index("idx_cron_jobs_control_created").on(table.controlChatId, table.createdAt),
    index("idx_cron_jobs_owner_created").on(table.ownerMemberId, table.createdAt),
    check("ck_cron_jobs_state", sql`${table.state} IN ('active', 'paused')`),
    check("ck_cron_jobs_chat_mode", sql`${table.chatMode} = 'reuse_control_chat'`),
    check("ck_cron_jobs_revision_positive", sql`${table.revision} > 0`),
    check(
      "ck_cron_jobs_active_shape",
      sql`(${table.state} = 'active' AND ${table.nextRunAt} IS NOT NULL AND ${table.stateReason} IS NULL) OR (${table.state} = 'paused' AND ${table.nextRunAt} IS NULL AND ${table.stateReason} IS NOT NULL)`,
    ),
  ],
);

export type CronJobRow = typeof cronJobs.$inferSelect;
export type NewCronJobRow = typeof cronJobs.$inferInsert;
