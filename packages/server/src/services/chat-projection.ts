/**
 * Chat-first workspace — append-only post-fan-out projection.
 *
 * The single sanctioned extension point on the message hot path. Called
 * from `services/message.ts` AFTER existing fan-out completes, inside the
 * same transaction. Four responsibilities:
 *
 *   1. Chats projection: roll forward `chats.last_message_at`,
 *      `chats.last_message_preview`. Powers the conversation list cursor +
 *      sort + preview.
 *
 *   2. Engagement auto-revive: flip `chat_user_state.engagement_status`
 *      from `archived` → `active` for everyone watching this chat. `deleted`
 *      rows are sticky and intentionally untouched.
 *
 *   3. Mention propagation: increment `unread_mention_count` for mentioned
 *      speaking participants AND for watcher rows whose managed agent was
 *      mentioned. Sender row is excluded.
 *
 *   4. Realtime kick: fire-and-forget `pg_notify('chat_message_events', …)`
 *      so admin WS sockets can translate it into a `chat:message` frame.
 *      Failure is swallowed — durable persistence is the correctness path.
 *
 * Strict invariants (see first-tree-context:agent-hub/web-console.md
 * "Risk Constraints"):
 *   - This module appends ONLY. Never edits existing fan-out / inbox /
 *     mention-extraction code.
 *   - Watcher rows (chat_membership with access_mode='watcher') are
 *     NEVER added to inbox_entries here. Their counters in
 *     chat_user_state are bumped purely as a per-user red-dot signal.
 *   - Mention candidate set is `chat_membership` speakers only;
 *     watchers are not direct `@`-mention targets.
 */

import { CHAT_ENGAGEMENT_STATUSES } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { chats } from "../db/schema/chats.js";

const { ACTIVE, ARCHIVED } = CHAT_ENGAGEMENT_STATUSES;

// biome-ignore lint/suspicious/noExplicitAny: cross-schema compatibility
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

/** PG channel name carrying chat-message wakes. Payload: `<chatId>:<messageId>`. */
export const CHAT_MESSAGE_EVENTS_CHANNEL = "chat_message_events";

// ---------------------------------------------------------------------------
// Global chat-message notifier accessor
// ---------------------------------------------------------------------------
//
// Mirrors the pattern in `services/admin-broadcast.ts`. Registered once at
// app boot with the live notifier so the message hot path (services/message.ts)
// can fire the kick without taking on a new constructor parameter.

type ChatMessageDispatcher = (chatId: string, messageId: string) => void;
let dispatcher: ChatMessageDispatcher | null = null;

export function registerChatMessageDispatcher(fn: ChatMessageDispatcher): void {
  dispatcher = fn;
}

export function resetChatMessageDispatcher(): void {
  dispatcher = null;
}

/**
 * Best-effort cross-process kick for the chat-first workspace. Call AFTER
 * the message transaction commits — never inside the tx. Failure logs +
 * drops; web reconnect refetches.
 *
 * Speakers also get an inbox NOTIFY through the existing path. They will
 * receive both, and the web client de-dupes naturally because both end up
 * invalidating the same query keys.
 */
export function fireChatMessageKick(chatId: string, messageId: string): void {
  if (!dispatcher) return;
  try {
    dispatcher(chatId, messageId);
  } catch {
    // swallow — best-effort
  }
}

export type ApplyAfterFanOutInput = {
  chatId: string;
  messageId: string;
  senderId: string;
  /** Agent uuids resolved as `@`-mentions for this message. May be empty. */
  mentionedAgentIds: string[];
  /** Trimmed message text used for the projection preview. Empty for non-text. */
  contentPreview: string;
  /** When set, used as the `last_message_at` instead of NOW(). */
  messageCreatedAt?: Date;
};

/**
 * Apply the post-fan-out projection. MUST be called inside the same
 * transaction as the message INSERT. Safe to call when `mentionedAgentIds`
 * is empty (degenerate case skips the mention UPDATEs).
 */
export async function applyAfterFanOut(tx: DbLike, input: ApplyAfterFanOutInput): Promise<void> {
  const { chatId, senderId, mentionedAgentIds, contentPreview, messageCreatedAt } = input;
  const previewClipped = contentPreview.length > 0 ? contentPreview.slice(0, 200) : null;
  const ts = messageCreatedAt ?? new Date();

  // 1. Chats projection — single statement via the typed builder so the Date
  // → timestamptz binding goes through drizzle's column-type serializer.
  // (Raw `sql` template hands the Date straight to postgres-js, which can't
  // serialize it without an explicit serializer setting.)
  // NOTE: `updated_at` is intentionally NOT touched here. `services/message.ts`
  // step 5 has already set `chats.updated_at = NOW()` earlier in the same
  // transaction; setting it again to `messageCreatedAt` would be a
  // redundant write that may leave the value slightly behind real time.
  await tx.update(chats).set({ lastMessageAt: ts, lastMessagePreview: previewClipped }).where(eq(chats.id, chatId));

  // 2. Engagement auto-revive: any participant whose `chat_user_state` row
  // sits in `archived` flips back to `active` on a new message. `deleted`
  // is sticky (only restorable via the chat detail page). Lazy-materialised
  // rows that don't exist yet match zero — they remain implicitly `'active'`
  // until first markRead / engagement transition / mention bump creates them.
  //
  // Includes the sender themselves: sending a message is a legitimate signal
  // that the user re-engaged with the chat, so their own archived row revives
  // (matches the original design intent in closed PR #316).
  await tx.execute(sql`
    UPDATE chat_user_state
       SET engagement_status = ${ACTIVE}
     WHERE chat_id = ${chatId}
       AND engagement_status = ${ARCHIVED}
  `);

  if (mentionedAgentIds.length === 0) return;

  // 3. Mention counter propagation — single UPSERT into chat_user_state.
  //
  // The target set is built via a UNION of two disjoint queries
  // (access_mode='speaker' XOR access_mode='watcher' is enforced by the
  // chat_membership table structure), so the same (chat_id, agent_id)
  // row never appears twice in the VALUES list — safe for ON CONFLICT
  // DO UPDATE.
  //
  // Speaker branch:
  //   - target = mentioned ∩ chat speakers, sender excluded
  //   - these agents were directly @-mentioned in the message
  //
  // Watcher branch:
  //   - target = (manager's human-agent) of any mentioned non-human,
  //     restricted to watchers of this chat (i.e. the manager itself
  //     is NOT a speaker — otherwise their counter is already bumped
  //     by the speaker branch via the explicit @ on themselves).
  //   - sender exclusion is not needed here: the sender is by
  //     definition a speaker, never a watcher row.
  //
  // chat_user_state rows are lazily materialised: missing → INSERT
  // with count=1; existing → UPDATE count = count + 1.
  const mentionedList = sql.join(
    mentionedAgentIds.map((id) => sql`${id}`),
    sql`, `,
  );

  await tx.execute(sql`
    INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count)
    SELECT chat_id, agent_id, 1
      FROM (
        SELECT cm.chat_id, cm.agent_id
          FROM chat_membership cm
         WHERE cm.chat_id     = ${chatId}
           AND cm.access_mode = 'speaker'
           AND cm.agent_id    IN (${mentionedList})
           AND cm.agent_id   <> ${senderId}
        UNION
        SELECT cm.chat_id, cm.agent_id
          FROM chat_membership cm
          JOIN members m  ON m.agent_id    = cm.agent_id
          JOIN agents  a  ON a.manager_id  = m.id
         WHERE cm.chat_id     = ${chatId}
           AND cm.access_mode = 'watcher'
           AND a.uuid         IN (${mentionedList})
           AND a.type        <> 'human'
           AND m.status       = 'active'
      ) targets
    ON CONFLICT (chat_id, agent_id)
    DO UPDATE SET unread_mention_count = chat_user_state.unread_mention_count + 1
  `);
}
