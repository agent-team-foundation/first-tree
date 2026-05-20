import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Unified membership table. Replaces the two-table split
 * (chat_participants speakers ∪ chat_subscriptions watchers) — both
 * collapse into a single row keyed by (chat_id, agent_id) with two
 * orthogonal columns:
 *
 *   - `role` ∈ owner / member  (creator-vs-member, governs admin actions)
 *   - `access_mode` ∈ speaker / watcher  (fan-out + mention candidacy)
 *
 * `(owner, speaker)`, `(member, speaker)`, `(member, watcher)` are the
 * legal combinations. `(owner, watcher)` is structurally possible but
 * never produced by v1 paths — the creator is always a speaker.
 *
 * Service-layer integrity (no FK / CHECK / trigger), matching the
 * messages / inbox_entries / notifications convention. Chat hard-delete
 * paths must explicitly DELETE rows here (service-level cascade) — the
 * old DB-level `ON DELETE CASCADE` is intentionally not preserved.
 *
 * See proposals/chat-data-model-restructure.20260512.md §8.
 */
export const chatMembership = pgTable(
  "chat_membership",
  {
    chatId: text("chat_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull().default("member"),
    accessMode: text("access_mode").notNull(),
    /**
     * **v2 dead code** — written as the constant `'mention_only'` by every
     * speaker write path; never read by fan-out / enforcement / dispatcher.
     * The column is retained as schema scaffolding for a future
     * per-receiver wake-policy extension point (e.g. push notifications
     * for mentioned humans, per-recipient silent flags).
     *
     * The DB default stays `'full'` so any future caller that bypasses
     * `addChatParticipants` and inserts without setting `mode` still
     * satisfies NOT NULL; the value chosen there is harmless because no
     * code path reads it. Drop migration is deferred until the wire-protocol
     * `recipientMode` field is removed (requires a coordinated server +
     * client release). See
     * proposals/hub-chat-message-v2-simplify-mode.20260520.md.
     */
    mode: text("mode").notNull().default("full"),
    source: text("source").notNull().default("manual"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_membership_agent").on(table.agentId),
    index("idx_membership_chat_role").on(table.chatId, table.accessMode),
  ],
);
