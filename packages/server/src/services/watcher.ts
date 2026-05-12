/**
 * Chat-first workspace — watcher subscription helpers.
 *
 * Watchers (rows in `chat_subscriptions`) are non-speaking observers. A
 * member who manages an agent that participates in a chat — but whose own
 * human agent is not a speaker there — sees the chat in their workspace
 * via a watcher row.
 *
 * Two distinct kinds of operation live here:
 *
 *   1. Set rebuilds (`recompute*`). Idempotent set-based recomputations
 *      driven by lifecycle events (chat created, participant added/removed,
 *      member status flipped, etc.). These DEFAULT new rows to NULL/0 read
 *      state.
 *
 *   2. State-carry transitions (`joinAsParticipant`, `leaveAsParticipant`).
 *      Move a single (chat, agent) pair between `chat_participants` and
 *      `chat_subscriptions` while preserving `last_read_at` and
 *      `unread_mention_count`. NEVER call recompute on this path or you'll
 *      lose read state.
 *
 * See docs/chat-first-workspace-product-design.md "State Transitions" and
 * "Risk Constraints".
 */

import { and, eq, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chatSubscriptions } from "../db/schema/chats.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { addChatParticipants, changeChatType, wouldUpgradeToGroup } from "./participant-mode.js";

/**
 * Structural DB type that accepts both the top-level `Database` and a
 * transaction client. We widen via `PgDatabase` so the schema generic stays
 * unconstrained.
 */
// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

// ---------------------------------------------------------------------------
// Recompute helpers — set rebuilds. Idempotent. Default read state.
// ---------------------------------------------------------------------------

/**
 * Recompute watcher rows for ONE chat. For every active member who:
 *   - manages a non-human agent that speaks in the chat, AND
 *   - whose own human agent is NOT a speaker in the chat
 * an `(chat_id, member.agent_id)` watcher row is upserted (NULL read state).
 *
 * Watchers whose anchoring condition no longer holds (manager left, the
 * managed agent was removed from the chat, the manager joined as a speaker
 * themselves) are deleted.
 *
 * Idempotent: safe to call multiple times for the same chat.
 */
export async function recomputeChatWatchers(db: DbLike, chatId: string): Promise<void> {
  // Insert the desired set; ON CONFLICT keeps existing read state intact.
  await db.execute(sql`
    INSERT INTO chat_subscriptions
      (chat_id, agent_id, kind, last_read_at, unread_mention_count, created_at)
    SELECT DISTINCT cp.chat_id, m.agent_id, 'watching', NULL::timestamp with time zone, 0, now()
      FROM chat_participants cp
      JOIN agents  a ON a.uuid = cp.agent_id
      JOIN members m ON m.id   = a.manager_id
     WHERE cp.chat_id = ${chatId}
       AND m.status   = 'active'
       AND a.type    <> 'human'
       AND NOT EXISTS (
         SELECT 1 FROM chat_participants cp2
          WHERE cp2.chat_id  = cp.chat_id
            AND cp2.agent_id = m.agent_id
       )
    ON CONFLICT (chat_id, agent_id) DO NOTHING
  `);

  // Drop watcher rows whose anchoring condition no longer holds.
  await db.execute(sql`
    DELETE FROM chat_subscriptions cs
     WHERE cs.chat_id = ${chatId}
       AND NOT EXISTS (
         SELECT 1
           FROM chat_participants cp
           JOIN agents  a ON a.uuid = cp.agent_id
           JOIN members m ON m.id   = a.manager_id
          WHERE cp.chat_id = cs.chat_id
            AND m.agent_id = cs.agent_id
            AND m.status   = 'active'
            AND a.type    <> 'human'
            AND NOT EXISTS (
              SELECT 1 FROM chat_participants cp2
               WHERE cp2.chat_id  = cp.chat_id
                 AND cp2.agent_id = m.agent_id
            )
       )
  `);
}

/**
 * Recompute watcher rows touching ONE agent across all chats it speaks in.
 * Used after `rebindAgent` (manager change) so the new manager picks up
 * watcher rows and the old manager's are dropped.
 */
export async function recomputeWatchersForAgent(db: DbLike, agentId: string): Promise<void> {
  const chatRows = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentId));
  for (const { chatId } of chatRows) {
    await recomputeChatWatchers(db, chatId);
  }
}

/**
 * Recompute watcher rows touching ONE member across all chats. Triggered
 * when the member's status flips active ↔ left.
 */
export async function recomputeWatchersForMember(db: DbLike, memberId: string): Promise<void> {
  // Find all chats where this member's managed non-human agents participate.
  const rows = await db
    .selectDistinct({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(and(eq(agents.managerId, memberId), ne(agents.type, "human")));

  for (const { chatId } of rows) {
    await recomputeChatWatchers(db, chatId);
  }
}

// ---------------------------------------------------------------------------
// State-carry transitions. Single transaction. NEVER call recompute here.
// ---------------------------------------------------------------------------

export type JoinResult = {
  chatId: string;
  /** True when the call inserted a fresh participant row (vs. no-op if already a member). */
  inserted: boolean;
  /** Read state carried forward from a watcher row, if one existed. */
  carried: { lastReadAt: Date | null; unreadMentionCount: number } | null;
};

/**
 * Watcher → speaking participant. State-carry transaction.
 *
 *   1. DELETE the watcher row (returning read state).
 *   2. If a participant row already exists, no-op (idempotent).
 *   3. Otherwise, run the direct → group upgrade rule against the *current*
 *      participant set, then INSERT the participant row carrying read state.
 *
 * If `requireWatcherOrVisible` is true, refuse when the user has neither a
 * watcher row nor admin-derived visibility — used to keep the public
 * `/me/chats/:chatId/join` endpoint honest. Pre-check happens in the
 * route layer where we have the full member scope.
 */
export async function joinAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<JoinResult> {
  return db.transaction(async (tx) => {
    const [carriedRow] = await tx
      .delete(chatSubscriptions)
      .where(and(eq(chatSubscriptions.chatId, chatId), eq(chatSubscriptions.agentId, humanAgentId)))
      .returning({
        lastReadAt: chatSubscriptions.lastReadAt,
        unreadMentionCount: chatSubscriptions.unreadMentionCount,
      });

    const [existing] = await tx
      .select({ chatId: chatParticipants.chatId })
      .from(chatParticipants)
      .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, humanAgentId)))
      .limit(1);
    if (existing) {
      return { chatId, inserted: false, carried: carriedRow ?? null };
    }

    const currentParticipants = await tx
      .select({ agentId: chatParticipants.agentId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    if (wouldUpgradeToGroup(currentParticipants.length, 1)) {
      await changeChatType(tx, chatId, "group");
    }

    // `/me/chats/:id/join` admits only the manager's human agent.
    // `assertHuman: true` makes a non-human caller surface as a 400 rather
    // than silently inserting with an inappropriate mode.
    await addChatParticipants(
      tx,
      chatId,
      [
        {
          agentId: humanAgentId,
          role: "member",
          carriedReadState: carriedRow
            ? { lastReadAt: carriedRow.lastReadAt, unreadMentionCount: carriedRow.unreadMentionCount }
            : undefined,
        },
      ],
      { assertHuman: true },
    );

    return { chatId, inserted: true, carried: carriedRow ?? null };
  });
}

export type LeaveResult = {
  chatId: string;
  /** "watching" if the user is still anchored to a managed agent; null if fully detached. */
  membershipKind: "watching" | null;
};

/**
 * Speaking participant → watcher (or fully detach).
 *
 *   1. DELETE the participant row (returning read state).
 *   2. Test "still visible": is the user still the manager of an agent that
 *      remains a participant in this chat? If yes, INSERT a watcher row
 *      carrying read state. If no, drop entirely.
 *
 * Caller must validate that the user actually has a participant row to
 * leave (returns `NotFoundError` if not).
 */
export async function leaveAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<LeaveResult> {
  return db.transaction(async (tx) => {
    const [carried] = await tx
      .delete(chatParticipants)
      .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, humanAgentId)))
      .returning({ lastReadAt: chatParticipants.lastReadAt, unreadMentionCount: chatParticipants.unreadMentionCount });
    if (!carried) throw new NotFoundError("Not a participant of this chat");

    // Still visible? The "user" here is identified by their human-agent uuid.
    // We need to find the matching member row in the chat's organisation and
    // check whether any of that member's managed non-human agents still
    // participates. SQL does the join in one shot.
    const [stillVisibleRow] = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM chat_participants cp
          JOIN agents  a ON a.uuid = cp.agent_id
          JOIN members m ON m.id   = a.manager_id
         WHERE cp.chat_id = ${chatId}
           AND m.agent_id = ${humanAgentId}
           AND m.status   = 'active'
           AND a.type    <> 'human'
      ) AS visible
    `);
    const stillVisible = Boolean(stillVisibleRow?.visible);

    if (!stillVisible) {
      return { chatId, membershipKind: null };
    }

    await tx
      .insert(chatSubscriptions)
      .values({
        chatId,
        agentId: humanAgentId,
        kind: "watching",
        lastReadAt: carried.lastReadAt,
        unreadMentionCount: carried.unreadMentionCount,
      })
      .onConflictDoNothing();

    return { chatId, membershipKind: "watching" };
  });
}

// ---------------------------------------------------------------------------
// Visibility / role checks
// ---------------------------------------------------------------------------

/**
 * Resolve the membership row of the human agent for the given chat. Returns
 * one of: 'participant', 'watching', or null.
 *
 * Used by `/me/chats/:chatId/join` to refuse a join when the user has
 * neither a watcher row nor a participant row, and isn't otherwise
 * authorised (admin in the chat's org).
 */
export async function resolveChatMembership(
  db: DbLike,
  chatId: string,
  humanAgentId: string,
): Promise<"participant" | "watching" | null> {
  const [participant] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, humanAgentId)))
    .limit(1);
  if (participant) return "participant";

  const [sub] = await db
    .select({ chatId: chatSubscriptions.chatId })
    .from(chatSubscriptions)
    .where(and(eq(chatSubscriptions.chatId, chatId), eq(chatSubscriptions.agentId, humanAgentId)))
    .limit(1);
  if (sub) return "watching";

  return null;
}

/**
 * Used by `/me/chats/:chatId/join`. Throw 409 if already a speaker (no work
 * to do) and 403 if no watcher row and no admin override. Admin override is
 * resolved at the route layer; this helper only reports the watcher state.
 */
export function ensureCanJoin(membership: "participant" | "watching" | null): void {
  if (membership === "participant") {
    throw new ConflictError("Already a participant in this chat");
  }
  if (membership === null) {
    throw new ForbiddenError("Not a watcher of this chat — open the chat from your workspace before joining");
  }
}
