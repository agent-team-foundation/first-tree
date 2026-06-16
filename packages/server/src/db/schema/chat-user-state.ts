import { sql } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-(chat, agent) user state — independent from membership structure.
 *
 * This is the third layer of the chat data model: while `chats` owns
 * the entity and `chat_membership` owns the structural relation
 * (who can speak, who watches), this table owns the user's private
 * state about a chat. The reason it lives apart: structural changes
 * (speaker ↔ watcher, manager rebind, recompute) must never overwrite
 * user-private state — physical separation makes that an invariant
 * rather than a service-layer discipline.
 *
 * Columns evolve incrementally as new per-user state is needed.
 * Currently:
 *   - `last_read_at`, `unread_mention_count` — seeded by PR-A from
 *     the legacy `chat_participants` / `chat_subscriptions` columns.
 *   - `engagement_status` — added in 0040; per-(chat, user) view
 *     state (active / archived / deleted). Auto-revives archived →
 *     active on new message; deleted is sticky (only the user can
 *     restore from the chat detail page).
 *
 * Future fields slated for this table: pinned, mute_until, draft,
 * custom_title, last_seen_at — each as a separate change.
 *
 * Rows are lazy-upserted on first user write (markRead / mention
 * counter bump / engagement transition). Reads use COALESCE for
 * defaults so callers see `'active'` etc. even when no row exists.
 * Service-layer integrity (no FK / CHECK / trigger).
 *
 * See proposals/chat-data-model-restructure.20260512.md §8.6.
 */
export const chatUserState = pgTable(
  "chat_user_state",
  {
    chatId: text("chat_id").notNull(),
    agentId: text("agent_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    unreadMentionCount: integer("unread_mention_count").notNull().default(0),
    /**
     * Count of open questions (`messages.format = 'request'`) directed at
     * this (chat, human) — incremented on RAISE, decremented by an EXPLICIT
     * resolution (a message carrying `metadata.resolves` pointed at the
     * question — the human's clean answer, or the asking agent's
     * `chat ask --answer`). NOT decremented by plain threaded replies
     * (`inReplyTo` is pure threading now), so a "chat about this" discussion
     * keeps the question open. Drives the re-introduced `needs_you` red-dot.
     *
     * Mirrors `unread_mention_count`'s storage shape, but with the OPPOSITE
     * clear semantics: this is **answer-cleared, NOT read-cleared** — it is
     * deliberately NOT reset by `markMeChatRead`. "Has an unanswered question
     * directed at me", not "has unread mentions". See
     * proposals/group-chat-unified-send §D1.
     */
    openRequestCount: integer("open_request_count").notNull().default(0),
    /**
     * Per-(chat, user) view state. See `CHAT_ENGAGEMENT_STATUSES` in
     * shared for the legal values and semantics. Lazy default `'active'`
     * matches what `COALESCE(..., 'active')` returns for missing rows.
     */
    engagementStatus: text("engagement_status").notNull().default("active"),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.agentId] }),
    index("idx_user_state_agent").on(table.agentId),
    /**
     * Partial index for the unread-badge / `?filter=unread` lookup.
     * Most rows have `unread_mention_count = 0` at any moment, so a
     * partial index is bounded by the actual unread row count rather
     * than the full table.
     */
    index("idx_user_state_unread").on(table.agentId).where(sql`unread_mention_count > 0`),
    /**
     * Partial index for the `needs_you` / "my open questions" lookup —
     * bounded by the (small) set of rows with an unanswered question.
     */
    index("idx_user_state_open_req").on(table.agentId).where(sql`open_request_count > 0`),
  ],
);
