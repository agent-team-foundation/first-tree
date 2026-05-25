/**
 * Single source of truth for writing speaker rows into `chat_membership`.
 *
 * **This is the ONLY place in the codebase that may INSERT speaker rows
 * (access_mode = 'speaker') into `chat_membership`.** Do not call
 * `tx.insert(chatMembership)` with `accessMode: 'speaker'` from anywhere
 * else. The original bug (docs/chat-participant-mode-fix-design.md §1.1)
 * was caused by mode-derivation logic scattered across ten insert sites;
 * keeping a single writer remains the right shape even after v2 retired
 * the `mode` field from the decision path — a future per-receiver wake
 * policy will land here too.
 *
 * Watcher rows (access_mode = 'watcher') are written from
 * `services/watcher.ts::recomputeChatWatchers` via raw SQL; they don't
 * go through this service because the historic mode rule was `full` by
 * construction for watchers (they receive but don't fan out) and v2 made
 * the column decision-inert anyway.
 *
 * All callers that need to add a participant — `createChat`,
 * `addParticipant`, `ensureParticipant`, `joinChat`, `createMeChat`,
 * `addMeChatParticipants`, `findOrCreateChatForChannel`,
 * `joinAsParticipant`, … — go through `addChatParticipants`.
 *
 * v2 change (proposals/hub-chat-message-v2-simplify-mode.20260520.md):
 *
 *   - `chat_membership.mode` is **decision-inert**. fan-out / enforcement
 *     / dispatcher no longer read it. The historical `defaultParticipantMode`
 *     derivation has been removed; every freshly-written speaker row gets
 *     `mode = "mention_only"` as a constant. The column itself is retained
 *     as schema scaffolding for a future per-receiver wake-policy
 *     extension (e.g. per-recipient push notifications).
 *
 *   - `chats.type` is locked to `'group'` since first-tree-context
 *     PR #465; speaker-write code no longer reads it.
 *
 * Read state (`last_read_at` / `unread_mention_count`) lives in a
 * structurally separate `chat_user_state` table whose rows survive
 * access_mode transitions untouched. A watcher → speaker promotion just
 * UPSERTs `chat_membership.access_mode`; the `chat_user_state` row (if
 * any) is unaffected — no state-carry transaction needed.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { BadRequestError, NotFoundError } from "../errors.js";
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
   * caller (e.g. `ensureParticipant`) doesn't blow up when the row already
   * exists.
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
   * `joinChat` / `joinAsParticipant` whose contracts only admit a manager's
   * human agent — anything else is a programming error that should crash
   * loudly rather than silently insert with the wrong access mode.
   */
  assertHuman?: boolean;
};

/**
 * Insert speaker rows.
 *
 * Reads:
 *   - `chats.id` for the target chat (NotFoundError on missing).
 *   - `agents.uuid`, `agents.type`, `agents.inboxId` for every requested
 *     participant (BadRequestError on missing). When `assertHuman` is set,
 *     also validates `agents.type`. `inboxId` feeds the silent-context
 *     backfill (see below).
 *   - `chat_membership` rows for the (chatId, agentIds) tuple, to classify
 *     each input as `alreadySpeaker` (skip) / `upgradingWatcher` / `brandNew`.
 *
 * Writes:
 *   - One INSERT (multi-row) into `chat_membership` per call.
 *   - One INSERT (multi-row) into `inbox_entries` carrying the chat's most
 *     recent N messages as silent (notify=false) rows, for every agent whose
 *     access_mode just transitioned to `speaker` (`brandNew` ∪
 *     `upgradingWatcher`). Skipped when no such transition happens.
 *
 * Why backfill lives here (not at the service entrypoints):
 *
 *   The "an agent crossing into `accessMode='speaker'` must be able to read
 *   prior chat history" invariant is a property of writing the membership
 *   row, not of any particular service entrypoint. Anchoring it to the
 *   single helper that owns the write means new service entrypoints
 *   (`addParticipant`, `addMeChatParticipants`, `ensureParticipant`,
 *   `joinChat`, `joinAsParticipant`, `findOrCreateChatForChannel`, …) all
 *   inherit it for free. The previous arrangement — backfill scattered at
 *   `addParticipant` only — regressed silently when the web path went
 *   through `addMeChatParticipants` instead (PR #393 follow-up).
 *
 * Watcher → speaker upgrades also backfill: watchers do not receive inbox
 * fan-out (`message.ts` filters by `access_mode='speaker'`), so the moment
 * they become speakers, everything before that moment is unreachable
 * without the silent-context replay.
 *
 * No watcher / audience-cache side effects — the caller owns those, since
 * different entrypoints have different surrounding work (watcher recompute,
 * audience invalidation). Keeping this module otherwise side-effect-free
 * makes it testable from any tx context. Backfill is the one exception
 * because, unlike watcher / audience cache, it is an invariant of writing
 * the row itself, not a choice the caller makes.
 *
 * v2: `chat_membership.mode` is written as the constant `"mention_only"`.
 * No chat-type / agent-type / peer-shape derivation. See file-level
 * comment + proposals/hub-chat-message-v2-simplify-mode.20260520.md.
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
    // `excluded.<col>` would reach back into the INSERT VALUES row; with
    // the constant `mode='mention_only'` there's nothing dynamic to carry
    // and we can spell the literal directly.
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

  // Silent-context backfill invariant. Triggers when an agent crosses into
  // `accessMode='speaker'` — either brand-new (no prior membership row) or
  // promoted from watcher. Already-speaker rows are skipped because
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
}
