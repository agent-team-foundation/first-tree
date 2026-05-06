/**
 * Chat-first workspace — append-only post-fan-out projection.
 *
 * The single sanctioned extension point on the message hot path. Called
 * from `services/message.ts` AFTER existing fan-out completes, inside the
 * same transaction. Three responsibilities:
 *
 *   1. Mention propagation: increment `unread_mention_count` for mentioned
 *      speaking participants AND for watcher rows whose managed agent was
 *      mentioned. Sender row is excluded.
 *
 *   2. Chats projection: roll forward `chats.last_message_at`,
 *      `chats.last_message_preview`. Powers the conversation list cursor +
 *      sort + preview.
 *
 *   3. Realtime kick: fire-and-forget `pg_notify('chat_message_events', …)`
 *      so admin WS sockets can translate it into a `chat:message` frame.
 *      Failure is swallowed — durable persistence is the correctness path.
 *
 * Strict invariants (see docs/chat-first-workspace-product-design.md
 * "Risk Constraints"):
 *   - This module appends ONLY. Never edits existing fan-out / inbox /
 *     mention-extraction code.
 *   - Watchers (chat_subscriptions) are NEVER added to inbox_entries here.
 *     Their counters are bumped purely as a per-user red-dot signal.
 *   - Mention candidate set is `chat_participants` only; watchers are not
 *     direct `@`-mention targets.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

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

  // 1. Chats projection — single statement.
  // NOTE: `updated_at` is intentionally NOT touched here. `services/message.ts`
  // step 5 has already set `chats.updated_at = NOW()` earlier in the same
  // transaction; setting it again to `messageCreatedAt` (which is the message
  // row's createdAt — set by the messages.created_at default) would be a
  // redundant write that may leave the value slightly behind real time on
  // hosts where the message timestamp resolves to an earlier instant than
  // the projection step.
  await tx.execute(sql`
    UPDATE chats
       SET last_message_at      = ${ts},
           last_message_preview = ${previewClipped}
     WHERE id = ${chatId}
  `);

  if (mentionedAgentIds.length === 0) return;

  // Drizzle's sql tag will inline the array as parameters.
  // 2a. Speaker counters — exclude sender; also a no-op when no row matches.
  await tx.execute(sql`
    UPDATE chat_participants
       SET unread_mention_count = unread_mention_count + 1
     WHERE chat_id = ${chatId}
       AND agent_id = ANY(${mentionedAgentIds})
       AND agent_id <> ${senderId}
  `);

  // 2b. Watcher counters — propagate to manager's human-agent row in
  //     chat_subscriptions for any non-human mentioned agent. The CTE keeps
  //     the manager-resolution close to the UPDATE so a future schema change
  //     to `agents.manager_id` shows up in one place. Sender exclusion is
  //     not needed here: a watcher row never represents the sender (sender
  //     is, by definition, a speaker).
  await tx.execute(sql`
    WITH targets AS (
      SELECT DISTINCT m.agent_id AS human_agent_id
        FROM agents a
        JOIN members m ON m.id = a.manager_id
       WHERE a.uuid = ANY(${mentionedAgentIds})
         AND a.type <> 'human'
         AND m.status = 'active'
    )
    UPDATE chat_subscriptions cs
       SET unread_mention_count = unread_mention_count + 1
     WHERE cs.chat_id = ${chatId}
       AND cs.agent_id IN (SELECT human_agent_id FROM targets)
  `);
}
