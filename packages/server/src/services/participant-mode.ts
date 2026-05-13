/**
 * Single source of truth for writing speaker rows into `chat_membership`.
 *
 * **This is the ONLY place in the codebase that may INSERT speaker rows
 * (access_mode = 'speaker') into `chat_membership`.** Do not call
 * `tx.insert(chatMembership)` with `accessMode: 'speaker'` from anywhere
 * else. The original bug (docs/chat-participant-mode-fix-design.md §1.1)
 * was caused by mode-derivation logic scattered across ten insert sites,
 * several of which violated `group + non-human ⇒ mention_only`.
 * Re-introducing a second writer reopens that hole — please don't.
 *
 * Watcher rows (access_mode = 'watcher') are written from
 * `services/watcher.ts::recomputeChatWatchers` via raw SQL; they don't
 * go through this service because the mode rule is `full` by construction
 * for watchers (they receive but don't fan out).
 *
 * Test fixtures under `src/__tests__/` that deliberately seed pathological
 * rows (e.g. cross-org pollution tests) may bypass this rule; they are
 * setting up "what bad data looks like" rather than exercising the
 * production write path.
 *
 * All callers that need to add a participant — `createChat`, `addParticipant`,
 * `ensureParticipant`, `joinChat`, `createMeChat`, `addMeChatParticipants`,
 * `findOrCreateDirectChat`, `findOrCreateChatForChannel`, `joinAsParticipant`,
 * … — go through `addChatParticipants`. The function performs ONE round-trip
 * to read `chats.type` + every involved `agents.type`, runs each row through
 * `defaultParticipantMode`, and inserts the result. `agents.type` is parsed
 * through the shared `agentTypeSchema` so schema drift surfaces loudly
 * instead of silently coercing to a default.
 *
 * `changeChatType` complements it on the type-flip path: when a `direct`
 * chat is being upgraded to `group` by the very next participant insert, the
 * existing non-human speakers must be re-graded to `mention_only`. Callers
 * that trigger an upgrade are expected to invoke `changeChatType` BEFORE
 * `addChatParticipants`, inside the same transaction, so the new row picks
 * up the post-upgrade `chats.type` and existing rows get re-graded together.
 *
 * Read state (`last_read_at` / `unread_mention_count`) is no longer carried
 * here: per the chat-data-model-restructure (proposal §8), it lives in a
 * structurally separate `chat_user_state` table whose rows survive
 * access_mode transitions untouched. A watcher → speaker promotion just
 * UPDATEs `chat_membership.access_mode`; the `chat_user_state` row (if any)
 * is unaffected — no state-carry transaction needed.
 */

import { agentTypeSchema, defaultParticipantMode } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { BadRequestError, NotFoundError } from "../errors.js";

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
   * `speaker` and `mode` is updated to the derived value. Used by
   * watcher → speaker transitions (join paths) where we want a single
   * atomic UPSERT rather than DELETE + INSERT (avoids an ephemeral
   * "no membership row" window that recomputeChatWatchers could observe).
   */
  upgradeWatcherToSpeaker?: boolean;
  /**
   * When true, every passed agent must be `type === 'human'`. Used by
   * `joinChat` / `joinAsParticipant` whose contracts only admit a manager's
   * human agent — anything else is a programming error that should crash
   * loudly rather than silently insert with the wrong mode.
   */
  assertHuman?: boolean;
};

/**
 * Insert speaker rows whose `mode` is derived from `(chats.type, agents.type)`.
 *
 * Reads:
 *   - `chats.type` for the target chat (NotFoundError on missing)
 *   - `agents.type` for every requested participant (BadRequestError on missing)
 *
 * Mode derivation:
 *   - for each row, `peerAgentTypes` is the type of every OTHER participant
 *     being inserted in the same call PLUS every EXISTING speaker of
 *     the chat. This matters only for `direct` chats; the helper ignores
 *     it for `group`.
 *
 * Writes one INSERT (multi-row) per call.
 *
 * No watcher / audience-cache side effects — the caller owns those, since
 * different entrypoints have different surrounding work (watcher recompute,
 * audience invalidation). Keeping this module side-effect-free makes it
 * testable from any tx context.
 */
export async function addChatParticipants(
  tx: DbLike,
  chatId: string,
  participants: ReadonlyArray<AddChatParticipantSpec>,
  options: AddChatParticipantsOptions = {},
): Promise<void> {
  if (participants.length === 0) return;

  const [chat] = await tx.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  // `chats.type` is `text` in the DB; narrow it to the discriminated
  // `ChatType` we accept. Any unknown value is a programming error.
  if (chat.type !== "direct" && chat.type !== "group") {
    throw new Error(`Unexpected chat type "${chat.type}" for chat "${chatId}"`);
  }
  const chatType = chat.type;

  const agentIds = participants.map((p) => p.agentId);
  const agentRows = await tx
    .select({ uuid: agents.uuid, type: agents.type })
    .from(agents)
    .where(inArray(agents.uuid, agentIds));
  const agentTypeById = new Map<string, string>();
  for (const row of agentRows) {
    agentTypeById.set(row.uuid, row.type);
  }
  const missing = agentIds.filter((id) => !agentTypeById.has(id));
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

  // For the `direct`-chat branch of `defaultParticipantMode`, peerAgentTypes
  // is the set of EVERY OTHER active speaker on this chat. For `group`
  // it's ignored, so skip the lookup when we can.
  let existingAgentTypes: string[] = [];
  if (chatType === "direct") {
    existingAgentTypes = await loadExistingAgentTypes(tx, chatId, new Set(agentIds));
  }

  const rows = participants.map((spec) => {
    const rawAgentType = agentTypeById.get(spec.agentId);
    // `rawAgentType` is guaranteed defined here — we threw above if missing.
    // Map.get widens to `string | undefined`, so guard explicitly rather
    // than non-null assert.
    if (rawAgentType === undefined) {
      throw new Error("Unexpected: agent type lookup unset after presence check");
    }
    // Run the value through the shared Zod enum so any schema drift (a
    // newly added `agents.type` not yet reflected in the helper's accepted
    // set) crashes loudly here instead of silently coercing to a default
    // and producing the wrong `mode`. The parse cost is negligible —
    // single-row enum check, no allocation beyond the throw path.
    const agentType = agentTypeSchema.parse(rawAgentType);
    const peerTypesForRow =
      chatType === "direct"
        ? [
            ...existingAgentTypes,
            ...participants
              .filter((p) => p.agentId !== spec.agentId)
              .map((p) => agentTypeById.get(p.agentId))
              .filter((t): t is string => t !== undefined),
          ].map((t) => agentTypeSchema.parse(t))
        : [];
    return {
      chatId,
      agentId: spec.agentId,
      role: spec.role ?? ("member" as const),
      accessMode: "speaker" as const,
      mode: defaultParticipantMode(chatType, agentType, peerTypesForRow),
      source: "manual" as const,
    };
  });

  const insert = tx.insert(chatMembership).values(rows);
  if (options.upgradeWatcherToSpeaker) {
    // Promote watcher → speaker in place: chat_user_state row (if any) is
    // structurally separate so the user's read state survives untouched.
    // Note: per-row `mode` is captured from the INSERT VALUES list so the
    // derived mode flows through correctly. `excluded` references the
    // would-have-been-inserted row from the VALUES clause.
    await insert.onConflictDoUpdate({
      target: [chatMembership.chatId, chatMembership.agentId],
      set: {
        accessMode: "speaker",
        mode: sqlExcluded("mode"),
        source: "manual",
      },
    });
  } else if (options.onConflictDoNothing) {
    await insert.onConflictDoNothing({ target: [chatMembership.chatId, chatMembership.agentId] });
  } else {
    await insert;
  }
}

/**
 * Drizzle helper: reference `excluded.<col>` in an UPSERT's UPDATE clause.
 * Returned as untyped SQL because Drizzle's type system doesn't model the
 * `excluded` pseudo-row, and we only use it for two simple text columns
 * here. Centralised so callers don't have to import `sql` just for this.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

async function loadExistingAgentTypes(tx: DbLike, chatId: string, excludeAgentIds: Set<string>): Promise<string[]> {
  const rows = await tx
    .select({ type: agents.type, agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  return rows.filter((r) => !excludeAgentIds.has(r.agentId)).map((r) => r.type);
}

/**
 * Upgrade `chats.type` from `direct` → `group` AND re-grade every existing
 * non-human speaker to `mention_only`. Idempotent: if `chat.type` is
 * already `group` (or any non-`direct` value), no-op.
 *
 * Callers that are about to insert a 3rd speaker on a `direct` chat
 * invoke this BEFORE `addChatParticipants` so the new row picks up the
 * post-upgrade `chats.type` and the existing rows are re-graded in the
 * same transaction.
 *
 * Re-grade is gated on `access_mode = 'speaker'` — watcher rows already
 * have `mode = 'full'` by construction (recompute writes that literal)
 * and don't participate in fan-out, so they need no touching.
 */
export async function changeChatType(tx: DbLike, chatId: string, newType: "group"): Promise<void> {
  const [chat] = await tx.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  if (chat.type === newType) return;
  if (newType === "group" && chat.type !== "direct") {
    // Only `direct → group` is allowed in Phase 1. `group → direct` is
    // ill-defined.
    throw new BadRequestError(`Cannot change chat type from "${chat.type}" to "${newType}"`);
  }

  await tx.update(chats).set({ type: newType, updatedAt: new Date() }).where(eq(chats.id, chatId));

  // Re-grade existing non-human speakers to `mention_only` — the
  // post-upgrade group rule. Humans stay `full`. The new participant that
  // triggered the upgrade is inserted separately by `addChatParticipants`.
  const nonHumans = await tx
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"), ne(agents.type, "human")));
  const ids = nonHumans.map((r) => r.agentId);
  if (ids.length === 0) return;
  await tx
    .update(chatMembership)
    .set({ mode: "mention_only" })
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        inArray(chatMembership.agentId, ids),
        eq(chatMembership.accessMode, "speaker"),
      ),
    );
}

/**
 * Heuristic for whether an insert about to happen would push the chat past
 * the direct → group threshold. Pure helper so callers can decide whether
 * to call `changeChatType` before `addChatParticipants` without re-deriving
 * the rule locally.
 */
export function wouldUpgradeToGroup(currentSpeakerCount: number, newSpeakerCount: number): boolean {
  return currentSpeakerCount + newSpeakerCount >= 3;
}
