import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";
import { organizations } from "./organizations.js";

/**
 * GitHub-specific webhook entity → chat clustering (Phase 0).
 *
 * Each `(organization, human_agent, delegate_agent, entity)` tuple resolves to
 * exactly one chat. Future external sources (Linear, Slack, …) get their own
 * tables — their entity models differ enough that a generic table would slip
 * back into untyped jsonb.
 *
 * `bound_via` distinguishes the first-touch row (`direct`) from a row written
 * by the `Fixes #N` linker (`fixes_link`). Routing logic ignores the
 * distinction; it exists for audit and future strategy tweaks.
 */
export const githubEntityChatMappings = pgTable(
  "github_entity_chat_mappings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    humanAgentId: text("human_agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    delegateAgentId: text("delegate_agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    /** GitHub entity discriminator — keeps in sync with `githubEntityTypeSchema`. */
    entityType: text("entity_type").notNull(),
    /** Stable cluster key, e.g. "owner/repo#42". */
    entityKey: text("entity_key").notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    /** "direct" | "fixes_link" — see file header. */
    boundVia: text("bound_via").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.humanAgentId, table.delegateAgentId, table.entityType, table.entityKey],
    }),
    index("idx_github_entity_chat_mappings_chat").on(table.chatId),
  ],
);
