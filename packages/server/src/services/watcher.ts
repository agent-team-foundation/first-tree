/**
 * Chat-first workspace — membership lifecycle helpers.
 *
 * After the chat data model restructure (see
 * proposals/chat-data-model-restructure.20260512.md §8), "watcher" is
 * just an `access_mode` value on `chat_membership`, not a separate
 * table. Speaker ↔ watcher transitions are a single-table UPDATE;
 * read state lives in `chat_user_state` and is structurally isolated
 * from access_mode changes — there is no state-carry path anymore.
 *
 * Two distinct kinds of operation live here:
 *
 *   1. Set rebuilds (`recompute*`). Idempotent set-based
 *      recomputations driven by lifecycle events (chat created,
 *      participant added/removed, member status flipped, agent
 *      rebind, etc.). Strict invariant: ONLY INSERT or DELETE rows
 *      where access_mode = 'watcher'. NEVER UPDATE any row with
 *      access_mode = 'speaker' — the user's own join/leave decision
 *      must not be overwritten by ops paths.
 *
 *   2. Speaker ↔ watcher transitions (`joinAsParticipant`,
 *      `leaveAsParticipant`). Single-table UPDATE on
 *      `chat_membership.access_mode`; `chat_user_state` rows for
 *      the (chat, agent) pair are not touched. Per §11.4 default,
 *      a fully-detached user keeps their `chat_user_state` row
 *      (read state remembered for re-add).
 *
 * File name preserved across the refactor for diff readability; may
 * be renamed in a follow-up. Public function names preserved too —
 * `recomputeChatWatchers` still describes what it does (recomputes
 * the watcher rows), so the rename to `recomputeChatMembership`
 * would obscure rather than clarify.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { addChatParticipants, changeChatType, wouldUpgradeToGroup } from "./participant-mode.js";

/**
 * Structural DB type that accepts both the top-level `Database` and a
 * transaction client.
 */
// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

// ---------------------------------------------------------------------------
// Recompute helpers — set rebuilds. Idempotent. Touch ONLY watcher rows.
// ---------------------------------------------------------------------------

/**
 * Recompute watcher rows for ONE chat. For every active member who:
 *   - manages a non-human agent that speaks in the chat, AND
 *   - whose own human agent is NOT a speaker in the chat
 * a `(chat_id, member.agent_id)` watcher row is upserted.
 *
 * Strict invariant: only writes rows with access_mode = 'watcher';
 * never updates or deletes any access_mode = 'speaker' row. The
 * ON CONFLICT DO NOTHING clause guarantees that if a (chat, agent)
 * row already exists as a speaker (the manager joined as a real
 * participant themselves), we leave it alone.
 *
 * Watchers whose anchoring condition no longer holds (manager left,
 * the managed agent was removed from the chat, the manager joined as
 * a speaker themselves) are deleted — also gated on access_mode =
 * 'watcher'.
 *
 * Idempotent: safe to call multiple times for the same chat.
 */
export async function recomputeChatWatchers(db: DbLike, chatId: string): Promise<void> {
  // Insert the desired set of watcher rows; speaker rows are
  // preserved by the ON CONFLICT clause + the NOT EXISTS guard in
  // the SELECT.
  await db.execute(sql`
    INSERT INTO chat_membership
      (chat_id, agent_id, role, access_mode, mode, source, joined_at)
    SELECT DISTINCT cm.chat_id, m.agent_id, 'member', 'watcher', 'full', 'auto_manager', now()
      FROM chat_membership cm
      JOIN agents  a ON a.uuid = cm.agent_id
      JOIN members m ON m.id   = a.manager_id
     WHERE cm.chat_id = ${chatId}
       AND cm.access_mode = 'speaker'
       AND m.status = 'active'
       AND a.type   <> 'human'
       AND NOT EXISTS (
         SELECT 1 FROM chat_membership cm2
          WHERE cm2.chat_id  = cm.chat_id
            AND cm2.agent_id = m.agent_id
       )
    ON CONFLICT (chat_id, agent_id) DO NOTHING
  `);

  // Drop watcher rows whose anchoring condition no longer holds.
  // Speaker rows are protected by the access_mode = 'watcher'
  // clause — they will never be touched here regardless of join
  // shape.
  await db.execute(sql`
    DELETE FROM chat_membership cm
     WHERE cm.chat_id = ${chatId}
       AND cm.access_mode = 'watcher'
       AND NOT EXISTS (
         SELECT 1
           FROM chat_membership speakers
           JOIN agents  a ON a.uuid = speakers.agent_id
           JOIN members m ON m.id   = a.manager_id
          WHERE speakers.chat_id     = cm.chat_id
            AND speakers.access_mode = 'speaker'
            AND m.agent_id           = cm.agent_id
            AND m.status             = 'active'
            AND a.type              <> 'human'
       )
  `);
}

/**
 * Recompute watcher rows touching ONE agent across all chats it
 * speaks in. Used after `rebindAgent` (manager change) so the new
 * manager picks up watcher rows and the old manager's are dropped.
 */
export async function recomputeWatchersForAgent(db: DbLike, agentId: string): Promise<void> {
  const chatRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(eq(chatMembership.agentId, agentId), eq(chatMembership.accessMode, "speaker")));
  for (const { chatId } of chatRows) {
    await recomputeChatWatchers(db, chatId);
  }
}

/**
 * Recompute watcher rows touching ONE member across all chats.
 * Triggered when the member's status flips active ↔ left.
 */
export async function recomputeWatchersForMember(db: DbLike, memberId: string): Promise<void> {
  const rows = await db
    .selectDistinct({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.accessMode, "speaker"), eq(agents.managerId, memberId), ne(agents.type, "human")));

  for (const { chatId } of rows) {
    await recomputeChatWatchers(db, chatId);
  }
}

// ---------------------------------------------------------------------------
// Speaker ↔ watcher transitions. Single-table UPDATE on access_mode.
// chat_user_state rows for the (chat, agent) pair are not touched.
// ---------------------------------------------------------------------------

export type JoinResult = {
  chatId: string;
  /** True when the call inserted a fresh `chat_membership` row (vs. UPDATE or no-op). */
  inserted: boolean;
  /**
   * Read state previously carried — always null in the new model.
   * Kept for API surface compatibility; `chat_user_state` is
   * structurally separate and is never touched by access_mode
   * transitions.
   */
  carried: null;
};

/**
 * Watcher → speaker (or fresh speaker insert).
 *
 *   1. SELECT the existing chat_membership row for the (chat, agent) pair.
 *   2. If already a speaker → no-op (idempotent).
 *   3. If a watcher row → run the direct→group upgrade rule, then
 *      UPDATE access_mode to 'speaker'.
 *   4. If no row → run the direct→group upgrade rule, then INSERT a
 *      fresh speaker row.
 *
 * Caller is expected to have verified the user is authorised to join
 * (admin override OR an existing watcher row); this helper does not
 * gate on visibility.
 */
export async function joinAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<JoinResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)))
      .limit(1);

    if (existing?.accessMode === "speaker") {
      return { chatId, inserted: false, carried: null };
    }

    const currentSpeakers = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    if (wouldUpgradeToGroup(currentSpeakers.length, 1)) {
      await changeChatType(tx, chatId, "group");
    }

    // `/me/chats/:id/join` admits only the manager's human agent.
    // `assertHuman: true` makes a non-human caller surface as a 400 rather
    // than silently inserting with an inappropriate mode.
    // `upgradeWatcherToSpeaker` promotes a pre-existing watcher row in place;
    // chat_user_state is structurally separate so the user's read state
    // survives untouched — no state-carry needed.
    await addChatParticipants(tx, chatId, [{ agentId: humanAgentId, role: "member" }], {
      assertHuman: true,
      upgradeWatcherToSpeaker: true,
    });

    return { chatId, inserted: !existing, carried: null };
  });
}

export type LeaveResult = {
  chatId: string;
  /** "watching" if the user is still anchored to a managed agent; null if fully detached. */
  membershipKind: "watching" | null;
};

/**
 * Speaker → watcher (or fully detach).
 *
 *   1. SELECT the existing speaker row; 404 if not present.
 *   2. Test "still visible": does the user still manage a non-human
 *      agent that remains a speaker in this chat?
 *      - If yes → UPDATE access_mode to 'watcher'.
 *      - If no  → DELETE the chat_membership row entirely.
 *   3. `chat_user_state` row (if any) is preserved either way per
 *      §11.4 default — read state is remembered for re-add.
 */
export async function leaveAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<LeaveResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)))
      .limit(1);
    if (!existing || existing.accessMode !== "speaker") {
      throw new NotFoundError("Not a participant of this chat");
    }

    // Still visible? The "user" here is identified by their
    // human-agent uuid. We find the matching member row in the
    // chat's organisation and check whether any of that member's
    // managed non-human agents still speaks in this chat.
    const result = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
          FROM chat_membership cm
          JOIN agents  a ON a.uuid = cm.agent_id
          JOIN members m ON m.id   = a.manager_id
         WHERE cm.chat_id = ${chatId}
           AND cm.access_mode = 'speaker'
           AND m.agent_id = ${humanAgentId}
           AND m.status   = 'active'
           AND a.type    <> 'human'
      ) AS visible
    `)) as unknown as Array<{ visible: boolean }>;
    const stillVisible = Boolean(result[0]?.visible);

    if (!stillVisible) {
      // Fully detach: DELETE chat_membership row. chat_user_state
      // row (if any) is preserved per §11.4 default — the user's
      // read state is remembered if they are ever re-added.
      await tx
        .delete(chatMembership)
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)));
      return { chatId, membershipKind: null };
    }

    // Downgrade speaker → watcher. chat_user_state untouched.
    await tx
      .update(chatMembership)
      .set({ accessMode: "watcher", mode: "full", source: "auto_manager" })
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)));
    return { chatId, membershipKind: "watching" };
  });
}

// ---------------------------------------------------------------------------
// Visibility / role checks
// ---------------------------------------------------------------------------

/**
 * Resolve the membership row of the human agent for the given chat.
 * Returns one of: 'participant' (speaker), 'watching' (watcher),
 * or null (no row).
 *
 * Used by `/me/chats/:chatId/join` to refuse a join when the user
 * has neither a watcher row nor a participant row, and isn't
 * otherwise authorised (admin in the chat's org).
 */
export async function resolveChatMembership(
  db: DbLike,
  chatId: string,
  humanAgentId: string,
): Promise<"participant" | "watching" | null> {
  const [row] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)))
    .limit(1);
  if (!row) return null;
  return row.accessMode === "speaker" ? "participant" : "watching";
}

/**
 * Used by `/me/chats/:chatId/join`. Throw 409 if already a speaker
 * (no work to do) and 403 if no row at all (admin override is
 * resolved at the route layer; this helper only reports the membership
 * state).
 */
export function ensureCanJoin(membership: "participant" | "watching" | null): void {
  if (membership === "participant") {
    throw new ConflictError("Already a participant in this chat");
  }
  if (membership === null) {
    throw new ForbiddenError("Not a watcher of this chat — open the chat from your workspace before joining");
  }
}
