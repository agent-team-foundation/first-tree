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
 *   3. Unread counter propagation: increment `unread_mention_count` via a
 *      single UNION'd UPSERT. Branches: mentioned HUMAN speakers (≠ sender),
 *      plus — when `bumpForAgentFinalText` is set — human speakers (≠ sender)
 *      and watchers whose managed agent IS the sender. UNION dedupes any
 *      target row that satisfies more than one branch so the counter
 *      advances by exactly +1 per message. The final-text branch
 *      restores the "agent finished → red dot" UX that PR #633 retired
 *      along with the 1:1 dmAuto projection.
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
  /**
   * When the send is an agent's final-text turn output (`purpose ===
   * "agent-final-text"` upstream), bump the unread counter for human
   * stakeholders of this chat even though the message has no `@`-mentions.
   * Targets:
   *   - human speakers (≠ sender) in this chat — the 1:1 human peer case.
   *   - watcher rows whose managed agent IS the sender — the group-chat
   *     case where the manager is a watcher, not a speaker.
   * Restores the "agent finished → red dot for the human" UX that the
   * previous 1:1 dmAuto + extractMentionsFromContent path provided before
   * PR #633 retired implicit routing.
   */
  bumpForAgentFinalText?: boolean;
};

/**
 * Apply the post-fan-out projection. MUST be called inside the same
 * transaction as the message INSERT. Safe to call when `mentionedAgentIds`
 * is empty (degenerate case skips the mention UPDATEs).
 */
export async function applyAfterFanOut(tx: DbLike, input: ApplyAfterFanOutInput): Promise<void> {
  const { chatId, senderId, mentionedAgentIds, contentPreview, messageCreatedAt, bumpForAgentFinalText } = input;
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
  // `activity_at` IS bumped: a new message is real work, so the conversation
  // list floats the chat by it (chats.activity_at is the recency sort key).
  // Monotonic via GREATEST: two qualifying writers (two sends, or a send + a
  // description change) can commit out of timestamp order, so a later-committing
  // older event must NOT move the recency key backwards.
  await tx
    .update(chats)
    .set({
      lastMessageAt: ts,
      lastMessagePreview: previewClipped,
      activityAt: sql`GREATEST(${chats.activityAt}, ${ts.toISOString()}::timestamptz)`,
    })
    .where(eq(chats.id, chatId));

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

  // 3. Unread counter propagation — single UPSERT into chat_user_state.
  //
  // Two source signals feed the same counter and must be merged before
  // the UPSERT to keep `+1 per message` semantics intact:
  //
  //   A. Mention propagation (always on when the message has explicit
  //      mentions). Single branch: mentioned ∩ chat speakers, sender excluded,
  //      HUMAN targets only — the unread-mention red dot is a human-attention
  //      signal, so mentioning a non-human agent (a delegate, a routed GitHub
  //      card target) wakes it via the inbox notify path but raises no red dot,
  //      and neither does the agent's human manager-watcher. Red dots are
  //      reserved for a human called directly by name.
  //
  //   B. Agent-final-text bump (only when `bumpForAgentFinalText`).
  //      `purpose === "agent-final-text"` carries empty mentions by
  //      construction — PR #633's explicit-only contract made it the
  //      one legal mentions-empty path, which incidentally retired the
  //      1:1 dmAuto projection that used to bump the human peer's red
  //      dot when their agent finished a turn. We restore that signal
  //      here without re-introducing implicit wake-up (inbox stays
  //      `notify=false` via `purposeProfile.forceSilentFanOut`).
  //      Speaker branch: human speakers (≠ sender) in this chat —
  //      covers 1:1 human-↔-agent. Watcher branch: watchers whose
  //      managed agent IS the sender — covers group chats where the
  //      manager doesn't speak.
  //
  // All applicable branches are UNIONed into a single SELECT. UNION is
  // set-distinct, so a target row that satisfies more than one branch
  // (e.g. final-text + explicit mention of the same human peer)
  // collapses to a single row → `unread_mention_count` advances by
  // exactly +1 per message regardless of how many branches hit it.
  // ON CONFLICT semantics mirror the prior implementation: missing
  // row → INSERT count=1; existing → UPDATE count = count + 1.
  const wantsMentionBump = mentionedAgentIds.length > 0;
  if (!wantsMentionBump && !bumpForAgentFinalText) return;

  const branches: ReturnType<typeof sql>[] = [];

  if (wantsMentionBump) {
    const mentionedList = sql.join(
      mentionedAgentIds.map((id) => sql`${id}`),
      sql`, `,
    );
    // Unread-mention red dots fire ONLY for a directly-@-mentioned human
    // speaker. Mentioning a non-human agent (a delegate, a routed card target)
    // wakes that agent via the inbox notify path but raises no red dot — and
    // neither does the agent's human manager-watcher. Red dots are reserved
    // for a human being called by name; a managed agent being mentioned is not
    // that signal.
    branches.push(sql`
      SELECT cm.chat_id, cm.agent_id
        FROM chat_membership cm
        JOIN agents a ON a.uuid = cm.agent_id
       WHERE cm.chat_id     = ${chatId}
         AND cm.access_mode = 'speaker'
         AND cm.agent_id    IN (${mentionedList})
         AND cm.agent_id   <> ${senderId}
         AND a.type         = 'human'
    `);
  }

  if (bumpForAgentFinalText) {
    branches.push(sql`
      SELECT cm.chat_id, cm.agent_id
        FROM chat_membership cm
        JOIN agents a ON a.uuid = cm.agent_id
       WHERE cm.chat_id     = ${chatId}
         AND cm.access_mode = 'speaker'
         AND cm.agent_id   <> ${senderId}
         AND a.type         = 'human'
    `);
    branches.push(sql`
      SELECT cm.chat_id, cm.agent_id
        FROM chat_membership cm
        JOIN members m ON m.agent_id    = cm.agent_id
        JOIN agents  a ON a.manager_id  = m.id
       WHERE cm.chat_id     = ${chatId}
         AND cm.access_mode = 'watcher'
         AND a.uuid         = ${senderId}
         AND a.type        <> 'human'
         AND m.status       = 'active'
    `);
  }

  const targets = sql.join(branches, sql` UNION `);

  await tx.execute(sql`
    INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count)
    SELECT chat_id, agent_id, 1
      FROM (${targets}) targets
    ON CONFLICT (chat_id, agent_id)
    DO UPDATE SET unread_mention_count = chat_user_state.unread_mention_count + 1
  `);
}
