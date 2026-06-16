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
 * `bound_via` records how the row came to exist — webhook first-touch
 * (`direct`), `Fixes #N` linker (`fixes_link`), human-scoped fallback
 * (`human_fallback`), or an explicit `github follow` (`agent_declared` /
 * `human_declared`). Routing logic ignores the distinction; it exists for
 * audit and the narrow `pull_request.opened` carve-out in
 * `services/github-audience.ts`. Canonical value docs: `BoundVia` in
 * `services/github-entity-chat.ts`.
 *
 * `entity_state` (added 0048) tracks the upstream PR/Issue lifecycle so
 * sidebar reads and the auto-archive sweeper can avoid GitHub API calls.
 * Updated by the webhook handler on PR/Issue lifecycle actions, including
 * PR draft transitions. New rows default to `'open'`.
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
    /** See file header — canonical value list lives on `BoundVia`. */
    boundVia: text("bound_via").notNull(),
    /** "open" (default) | "draft" | "closed" | "merged". See file header. */
    entityState: text("entity_state").notNull().default("open"),
    entityStateUpdatedAt: timestamp("entity_state_updated_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.humanAgentId, table.delegateAgentId, table.entityType, table.entityKey],
    }),
    index("idx_github_entity_chat_mappings_chat").on(table.chatId),
    index("idx_github_entity_chat_mappings_chat_state").on(table.chatId, table.entityState),
  ],
);
