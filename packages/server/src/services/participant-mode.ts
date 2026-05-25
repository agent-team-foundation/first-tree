/**
 * Single source of truth for writing `chat_membership` speaker rows and the
 * derived watcher set.
 *
 * **This is the ONLY place in the codebase that may INSERT speaker rows
 * (access_mode = 'speaker') into `chat_membership`.** Do not call
 * `tx.insert(chatMembership)` with `accessMode: 'speaker'` from anywhere
 * else. The original bug (docs/chat-participant-mode-fix-design.md §1.1)
 * was caused by mode-derivation logic scattered across ten insert sites;
 * keeping a single writer remains the right shape even after v2 retired
 * the `mode` field from the decision path.
 *
 * Invariants this module owns (anchored to the row-writing helper, not to
 * any particular service entrypoint, so any new join entrypoint inherits
 * them for free):
 *
 *   1. **Silent-context backfill** — every agent that crosses into
 *      `accessMode='speaker'` (brand-new or watcher → speaker upgrade)
 *      gets the chat's most recent N messages replayed as silent inbox
 *      rows. See `backfillSilentContextForNewParticipants` (inbox.ts).
 *
 *   2. **Watcher set recompute** — after any speaker write, the
 *      derived watcher set (managers of non-human speakers who are not
 *      themselves speakers) is reconciled. See `recomputeChatWatchers`
 *      below.
 *
 * A small caller-side bundle `applyMembershipWrite` is also exported here:
 * it wraps the canonical "open tx → write rows → commit → invalidate
 * audience cache" sequence so service entrypoints (`inviteParticipantsToChat`,
 * `ensureParticipant`, `joinAsParticipant`, …) don't each have to spell it
 * out and risk drifting on tx-boundary correctness.
 *
 * v2 change (proposals/hub-chat-message-v2-simplify-mode.20260520.md):
 *
 *   - `chat_membership.mode` is **decision-inert**. fan-out / enforcement
 *     / dispatcher no longer read it. Every freshly-written speaker row
 *     gets `mode = "mention_only"` as a constant. The column itself is
 *     retained as schema scaffolding for a future per-receiver wake-policy
 *     extension.
 *
 *   - `chats.type` is locked to `'group'` since first-tree-context
 *     PR #465; speaker-write code no longer reads it.
 *
 * Read state (`last_read_at` / `unread_mention_count`) lives in a
 * structurally separate `chat_user_state` table whose rows survive
 * access_mode transitions untouched.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { backfillSilentContextForNewParticipants } from "./inbox.js";

/**
 * Structural DB type that accepts both the top-level `Database` and a
 * transaction client. Mirrors the widening pattern in `services/watcher.ts`.
 */
// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

export type AddChatParticipantSpec = {
  agentId: string;
  /** Defaults to "member"; "owner" is reserved for the chat creator. */
  role?: "owner" | "member";
};

export type AddChatParticipantsOptions = {
  /**
   * When true, `INSERT ... ON CONFLICT DO NOTHING` is used so an idempotent
   * caller doesn't blow up when the row already exists.
   */
  onConflictDoNothing?: boolean;
  /**
   * When true, an existing watcher row for the (chat, agent) pair is
   * promoted in place via `ON CONFLICT DO UPDATE`: `access_mode` flips to
   * `speaker` and `mode` is rewritten to the v2 constant `"mention_only"`.
   * Used by watcher → speaker transitions (join paths) where we want a
   * single atomic UPSERT rather than DELETE + INSERT (avoids an ephemeral
   * "no membership row" window that recomputeChatWatchers could observe).
   */
  upgradeWatcherToSpeaker?: boolean;
  /**
   * When true, every passed agent must be `type === 'human'`. Used by
   * `joinAsParticipant` whose contract only admits a manager's human agent
   * — anything else is a programming error that should crash loudly rather
   * than silently insert with the wrong access mode.
   */
  assertHuman?: boolean;
};

/**
 * Insert speaker rows + maintain the two derived invariants
 * (silent-context backfill + watcher set recompute).
 *
 * Reads:
 *   - `chats.id` for the target chat (NotFoundError on missing).
 *   - `agents.uuid`, `agents.type`, `agents.inboxId` for every requested
 *     participant (BadRequestError on missing). When `assertHuman` is set,
 *     also validates `agents.type`. `inboxId` feeds the silent-context
 *     backfill.
 *   - `chat_membership` rows for the (chatId, agentIds) tuple, to classify
 *     each input as `alreadySpeaker` (skip) / `upgradingWatcher` / `brandNew`.
 *
 * Writes:
 *   - One INSERT (multi-row) into `chat_membership`.
 *   - One INSERT (multi-row) into `inbox_entries` carrying the chat's most
 *     recent N messages as silent (notify=false) rows, for every agent
 *     whose access_mode just transitioned to `speaker` (`brandNew` ∪
 *     `upgradingWatcher`).
 *   - Recomputes watcher rows for the chat (idempotent — `recomputeChatWatchers`
 *     ONLY INSERTs or DELETEs rows where `access_mode='watcher'`, never
 *     touches speaker rows).
 *
 * Side-effect boundary: this helper runs entirely inside the caller's tx.
 * The audience cache invalidation (which must happen AFTER commit) is the
 * caller's responsibility — see `applyMembershipWrite` for the canonical
 * tx-aware bundle.
 *
 * v2: `chat_membership.mode` is written as the constant `"mention_only"`.
 * No chat-type / agent-type / peer-shape derivation.
 */
export async function addChatParticipants(
  tx: DbLike,
  chatId: string,
  participants: ReadonlyArray<AddChatParticipantSpec>,
  options: AddChatParticipantsOptions = {},
): Promise<void> {
  if (participants.length === 0) return;

  // Confirm the chat exists. We no longer SELECT `chats.type` — it's locked
  // to 'group' and never read for membership decisions.
  const [chat] = await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }

  const agentIds = participants.map((p) => p.agentId);
  const agentRows = await tx
    .select({ uuid: agents.uuid, type: agents.type, inboxId: agents.inboxId })
    .from(agents)
    .where(inArray(agents.uuid, agentIds));
  const agentSet = new Set(agentRows.map((r) => r.uuid));
  const missing = agentIds.filter((id) => !agentSet.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }

  if (options.assertHuman) {
    const nonHuman = agentRows.filter((a) => a.type !== "human");
    if (nonHuman.length > 0) {
      throw new BadRequestError(
        `assertHuman violated: agents must be of type 'human' but got ${nonHuman.map((a) => `${a.uuid}=${a.type}`).join(", ")}`,
      );
    }
  }

  // Classify each requested agent against the live chat_membership row (if
  // any) so we can decide who actually crosses into speaker. Read inside the
  // caller's tx so a concurrent membership write can't move the line under us.
  const existing = await tx
    .select({ agentId: chatMembership.agentId, accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), inArray(chatMembership.agentId, agentIds)));
  const existingMode = new Map(existing.map((r) => [r.agentId, r.accessMode]));
  const inboxByAgent = new Map(agentRows.map((r) => [r.uuid, r.inboxId]));

  const rows = participants.map((spec) => ({
    chatId,
    agentId: spec.agentId,
    role: spec.role ?? ("member" as const),
    accessMode: "speaker" as const,
    mode: "mention_only" as const,
    source: "manual" as const,
  }));

  const insert = tx.insert(chatMembership).values(rows);
  if (options.upgradeWatcherToSpeaker) {
    // Promote watcher → speaker in place: chat_user_state row (if any) is
    // structurally separate so the user's read state survives untouched.
    await insert.onConflictDoUpdate({
      target: [chatMembership.chatId, chatMembership.agentId],
      set: {
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      },
    });
  } else if (options.onConflictDoNothing) {
    await insert.onConflictDoNothing({ target: [chatMembership.chatId, chatMembership.agentId] });
  } else {
    await insert;
  }

  // Invariant 1: silent-context backfill. Triggers when an agent crosses
  // into `accessMode='speaker'` — either brand-new (no prior membership
  // row) or promoted from watcher. Already-speaker rows are skipped because
  // re-inserting them was a no-op above. When `upgradeWatcherToSpeaker` is
  // not set, the watcher branch is naturally empty (the INSERT would have
  // crashed on the unique key) — defensive filtering keeps the contract
  // explicit either way.
  const crossingIntoSpeaker = participants.filter((p) => {
    const prior = existingMode.get(p.agentId);
    if (prior === "speaker") return false;
    if (prior === "watcher") return options.upgradeWatcherToSpeaker === true;
    return true;
  });
  if (crossingIntoSpeaker.length > 0) {
    const backfillTargets = crossingIntoSpeaker
      .map((p) => inboxByAgent.get(p.agentId))
      .filter((inboxId): inboxId is string => typeof inboxId === "string")
      .map((inboxId) => ({ inboxId }));
    await backfillSilentContextForNewParticipants(tx, chatId, backfillTargets);
  }

  // Invariant 2: derived watcher set. Always recompute — the helper is
  // idempotent and writes only watcher rows, so re-running it after a
  // speaker write is safe even when the speaker set didn't actually change
  // (the join path's no-op upgrade case). Cheaper to recompute
  // unconditionally than to risk drifting from the invariant.
  await recomputeChatWatchers(tx, chatId);
}

/**
 * Recompute watcher rows for ONE chat. For every active member who:
 *   - manages a non-human agent that speaks in the chat, AND
 *   - whose own human agent is NOT a speaker in the chat
 * a `(chat_id, member.agent_id)` watcher row is upserted.
 *
 * Strict invariant: only writes rows with access_mode = 'watcher';
 * never updates or deletes any access_mode = 'speaker' row. The
 * ON CONFLICT DO NOTHING clause guarantees that if a (chat, agent) row
 * already exists as a speaker, we leave it alone.
 *
 * Watchers whose anchoring condition no longer holds (manager left,
 * the managed agent was removed from the chat, the manager joined as a
 * speaker themselves) are deleted — also gated on access_mode = 'watcher'.
 *
 * Idempotent: safe to call multiple times for the same chat. This is the
 * property that lets `addChatParticipants` call it unconditionally on every
 * speaker write without needing to know whether watchers actually need to
 * change.
 *
 * Lives in this file (and not in `watcher.ts`) because watcher rows are a
 * derived projection of the speaker set: anchoring this function next to
 * the speaker writer is what lets us close the invariant loop.
 * `watcher.ts::recomputeWatchersForAgent` / `recomputeWatchersForMember`
 * delegate back here when their per-agent / per-member triggers fire.
 */
export async function recomputeChatWatchers(db: DbLike, chatId: string): Promise<void> {
  // Insert the desired set of watcher rows; speaker rows are preserved by
  // the ON CONFLICT clause + the NOT EXISTS guard in the SELECT.
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

  // Drop watcher rows whose anchoring condition no longer holds. Speaker
  // rows are protected by the access_mode = 'watcher' clause.
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
 * Canonical membership write bundle: open a transaction, run
 * `addChatParticipants` (which already encloses the silent-context backfill
 * and watcher-set recompute invariants), commit, then invalidate the
 * in-process WS audience cache.
 *
 * Why this is a separate function (and not inlined into
 * `addChatParticipants`): `invalidateChatAudience` is a process-local
 * cache invalidation, not a DB write — it MUST happen AFTER the
 * transaction commits, otherwise a concurrent reader could repopulate the
 * cache with the pre-commit speaker set. `addChatParticipants` runs inside
 * the caller's tx and has no commit hook, so it cannot own this step. The
 * bundle here makes the tx-boundary discipline a single decision instead
 * of N repeated decisions at each service entrypoint.
 *
 * Use this from service entrypoints (`inviteParticipantsToChat`,
 * `ensureParticipant`, the rebuild path of `joinAsParticipant`) rather
 * than spelling the three steps out yourself.
 */
export async function applyMembershipWrite(
  db: Database,
  chatId: string,
  participants: ReadonlyArray<AddChatParticipantSpec>,
  options: AddChatParticipantsOptions = {},
): Promise<void> {
  if (participants.length === 0) return;
  await db.transaction(async (tx) => {
    await addChatParticipants(tx, chatId, participants, options);
  });
  invalidateChatAudience(chatId);
}
