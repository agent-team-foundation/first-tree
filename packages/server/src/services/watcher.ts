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
 *   1. Per-agent / per-member recompute fan-out
 *      (`recomputeWatchersForAgent`, `recomputeWatchersForMember`).
 *      These translate a manager reassignment or member-status flip into a
 *      set of chat-scoped recomputes. The underlying chat-scoped
 *      operation `recomputeChatWatchers` itself lives in
 *      `participant-mode.ts` next to the speaker writer that owns
 *      the derivation invariant; we re-export it from here so
 *      historical callers keep working.
 *
 *   2. Speaker ↔ watcher transitions (`joinAsParticipant`,
 *      `leaveAsParticipant`). Single-table UPDATE on
 *      `chat_membership.access_mode`; `chat_user_state` rows for
 *      the (chat, agent) pair are not touched. Per §11.4 default,
 *      a fully-detached user keeps their `chat_user_state` row
 *      (read state remembered for re-add).
 */

import { and, eq, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { addChatParticipants, recomputeChatWatchers } from "./participant-mode.js";

// Re-export so historical callers that reach for
// `watcher.ts::recomputeChatWatchers` keep compiling. The canonical home
// for this function is now `participant-mode.ts` — anchored next to the
// speaker writer whose write triggers the derivation.
export { recomputeChatWatchers };

/**
 * Structural DB type that accepts both the top-level `Database` and a
 * transaction client.
 */
// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

// ---------------------------------------------------------------------------
// Per-agent / per-member recompute fan-out. Translate an event that touches
// one agent (manager reassignment) or one member (status flip) into the right
// set of chat-scoped recomputes.
// ---------------------------------------------------------------------------

/**
 * Recompute watcher rows touching ONE agent across all chats it
 * speaks in. Used after a manager reassignment (`updateAgent`) so the new
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
 *
 * Tx boundary: opens its own transaction (the `JoinResult` shape needs to
 * report whether a fresh row was inserted, which we compute from a SELECT
 * inside the tx). Audience-cache invalidation is enclosed here — after the
 * tx commits, `invalidateChatAudience` runs so the next `chat:message`
 * dispatch reflects the new speaker without waiting for the TTL window.
 * Callers do NOT need to call `invalidateChatAudience` themselves.
 */
export async function joinAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<JoinResult> {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)))
      .limit(1);

    if (existing?.accessMode === "speaker") {
      return { chatId, inserted: false, carried: null, mutated: false };
    }

    // v2: no chat-type flip needed — `chats.type` is locked to 'group' and
    // `chat_membership.mode` is decision-inert. Just upsert the speaker row.
    //
    // `/chats/:chatId/workspace-join` admits only the manager's human agent.
    // `assertHuman: true` makes a non-human caller surface as a 400 rather
    // than silently inserting.
    // `upgradeWatcherToSpeaker` promotes a pre-existing watcher row in
    // place; chat_user_state is structurally separate so the user's read
    // state survives untouched — no state-carry needed.
    await addChatParticipants(tx, chatId, [{ agentId: humanAgentId, role: "member" }], {
      assertHuman: true,
      upgradeWatcherToSpeaker: true,
    });

    return { chatId, inserted: !existing, carried: null, mutated: true };
  });

  // Enclosed post-commit step: drop the cached audience for this chat so the
  // newly-promoted speaker starts receiving `chat:message` pushes
  // immediately. Skipped on the no-op path (already a speaker) to avoid
  // pointlessly busting the cache.
  if (result.mutated) {
    invalidateChatAudience(chatId);
  }
  return { chatId: result.chatId, inserted: result.inserted, carried: result.carried };
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
 *
 * Tx boundary: opens its own transaction. Audience-cache invalidation is
 * enclosed here — after the tx commits, `invalidateChatAudience` runs so
 * subsequent `chat:message` dispatches stop pushing to the (now-departed)
 * speaker's WS connection. Callers do NOT need to call
 * `invalidateChatAudience` themselves.
 */
export async function leaveAsParticipant(db: Database, chatId: string, humanAgentId: string): Promise<LeaveResult> {
  const outcome = await db.transaction(async (tx): Promise<LeaveResult> => {
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

    // Downgrade speaker → watcher. chat_user_state is untouched (read
    // state survives the access_mode flip per §11.4). `mode` and
    // `source` are intentionally preserved so a later re-promotion via
    // `joinAsParticipant` keeps the agent's original mode (e.g.
    // `mention_only` instead of being silently reset to `full`). Even
    // though `addChatParticipants` re-derives `mode` on the promotion
    // UPSERT path today, leaving the original values in place is the
    // safer invariant — it means the watcher row is a faithful
    // snapshot of the speaker row minus the access_mode flip.
    await tx
      .update(chatMembership)
      .set({ accessMode: "watcher" })
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)));
    return { chatId, membershipKind: "watching" };
  });

  // Enclosed post-commit step: drop the cached audience for this chat so
  // the dispatcher stops pushing `chat:message` to the WS connection of
  // the user who just left. Always runs — every leave path here actually
  // mutates the row (the not-a-speaker case throws before reaching this
  // point), unlike `joinAsParticipant`'s already-a-speaker fast path.
  invalidateChatAudience(chatId);
  return outcome;
}

// ---------------------------------------------------------------------------
// Visibility / role checks
// ---------------------------------------------------------------------------

/**
 * Resolve the membership row of the human agent for the given chat.
 * Returns one of: 'participant' (speaker), 'watching' (watcher),
 * or null (no row).
 *
 * Used by `/chats/:chatId/workspace-join` to refuse a join when the user
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
 * Used by `/chats/:chatId/workspace-join`. Throw 409 if already a speaker
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
