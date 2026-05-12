/**
 * Single source of truth for writing `chat_participants`.
 *
 * All callers that need to add a participant — `createChat`, `addParticipant`,
 * `ensureParticipant`, `joinChat`, `createMeChat`, `addMeChatParticipants`,
 * `findOrCreateDirectChat`, `findOrCreateChatForChannel`, `joinAsParticipant`,
 * … — go through `addChatParticipants`. The function performs ONE round-trip
 * to read `chats.type` + every involved `agents.type`, runs each row through
 * `defaultParticipantMode`, and inserts the result.
 *
 * `changeChatType` complements it on the type-flip path: when a `direct`
 * chat is being upgraded to `group` by the very next participant insert, the
 * existing non-human rows must be re-graded to `mention_only`. Callers that
 * trigger an upgrade are expected to invoke `changeChatType` BEFORE
 * `addChatParticipants`, inside the same transaction, so the new row picks
 * up the post-upgrade `chats.type` and existing rows get re-graded together.
 *
 * Phase 1 invariant: a `tx.insert(chatParticipants)` outside this module is
 * a code-review violation. A CI grep (or ESLint rule, when Phase 2 lands)
 * pins this contract — see CI step in `.github/workflows/ci.yml`.
 */

import { agentTypeSchema, defaultParticipantMode } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
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
  /**
   * Carry-over read state when the agent is being promoted from
   * `chat_subscriptions` (watcher) → `chat_participants` (speaker).
   * Omit on fresh joins; the row defaults to `NULL` / `0`.
   */
  carriedReadState?: {
    lastReadAt: Date | null;
    unreadMentionCount: number;
  };
};

export type AddChatParticipantsOptions = {
  /**
   * When true, `INSERT ... ON CONFLICT DO NOTHING` is used so an idempotent
   * caller (e.g. `ensureParticipant`) doesn't blow up when the row already
   * exists.
   */
  onConflictDoNothing?: boolean;
  /**
   * When true, every passed agent must be `type === 'human'`. Used by
   * `joinChat` / `joinAsParticipant` whose contracts only admit a manager's
   * human agent — anything else is a programming error that should crash
   * loudly rather than silently insert with the wrong mode.
   */
  assertHuman?: boolean;
};

/**
 * Insert participant rows whose `mode` is derived from `(chats.type, agents.type)`.
 *
 * Reads:
 *   - `chats.type` for the target chat (NotFoundError on missing)
 *   - `agents.type` for every requested participant (BadRequestError on missing)
 *
 * Mode derivation:
 *   - for each row, `peerAgentTypes` is the type of every OTHER participant
 *     being inserted in the same call PLUS every EXISTING participant of
 *     the chat. This matters only for `direct` chats; the helper ignores
 *     it for `group` / `thread`.
 *
 * Writes one INSERT (multi-row) per call.
 *
 * No watcher / audience-cache side effects — the caller owns those, since
 * different entrypoints have different surrounding work (state-carry, watcher
 * recompute, audience invalidation). Keeping this module side-effect-free
 * makes it testable from any tx context.
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
  if (chat.type !== "direct" && chat.type !== "group" && chat.type !== "thread") {
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
  // is the set of EVERY OTHER active speaker on this chat. For `group`/
  // `thread` it's ignored, so skip the lookup when we can.
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
      role: spec.role ?? "member",
      mode: defaultParticipantMode(chatType, agentType, peerTypesForRow),
      lastReadAt: spec.carriedReadState?.lastReadAt ?? null,
      unreadMentionCount: spec.carriedReadState?.unreadMentionCount ?? 0,
    };
  });

  const insert = tx.insert(chatParticipants).values(rows);
  if (options.onConflictDoNothing) {
    await insert.onConflictDoNothing({ target: [chatParticipants.chatId, chatParticipants.agentId] });
  } else {
    await insert;
  }
}

async function loadExistingAgentTypes(tx: DbLike, chatId: string, excludeAgentIds: Set<string>): Promise<string[]> {
  const rows = await tx
    .select({ type: agents.type, agentId: chatParticipants.agentId })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(eq(chatParticipants.chatId, chatId));
  return rows.filter((r) => !excludeAgentIds.has(r.agentId)).map((r) => r.type);
}

/**
 * Upgrade `chats.type` from `direct` → `group` AND re-grade every existing
 * non-human participant to `mention_only`. Idempotent: if `chat.type` is
 * already `group` (or any non-`direct` value), no-op.
 *
 * Callers that are about to insert a 3rd participant on a `direct` chat
 * invoke this BEFORE `addChatParticipants` so the new row picks up the
 * post-upgrade `chats.type` and the existing rows are re-graded in the
 * same transaction.
 *
 * Note: this is the replacement for `services/chat.ts`'s
 * `maybeUpgradeDirectToGroup` (the one in `services/watcher.ts` is
 * removed). Keep the rename: `changeChatType` is more precise about the
 * primary mutation; `maybe…ToGroup` overstated the conditional gate.
 */
export async function changeChatType(tx: DbLike, chatId: string, newType: "group"): Promise<void> {
  const [chat] = await tx.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  if (chat.type === newType) return;
  if (newType === "group" && chat.type !== "direct") {
    // Only `direct → group` is allowed in Phase 1. `group → direct` is
    // ill-defined; `thread`-as-target isn't on the spec.
    throw new BadRequestError(`Cannot change chat type from "${chat.type}" to "${newType}"`);
  }

  await tx.update(chats).set({ type: newType, updatedAt: new Date() }).where(eq(chats.id, chatId));

  // Re-grade existing non-human participants to `mention_only` — the
  // post-upgrade group rule. Humans stay `full`. The new participant that
  // triggered the upgrade is inserted separately by `addChatParticipants`.
  const nonHumans = await tx
    .select({ agentId: chatParticipants.agentId })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(and(eq(chatParticipants.chatId, chatId), ne(agents.type, "human")));
  const ids = nonHumans.map((r) => r.agentId);
  if (ids.length === 0) return;
  await tx
    .update(chatParticipants)
    .set({ mode: "mention_only" })
    .where(and(eq(chatParticipants.chatId, chatId), inArray(chatParticipants.agentId, ids)));
}

/**
 * Heuristic for whether an insert about to happen would push the chat past
 * the direct → group threshold. Pure helper so callers can decide whether
 * to call `changeChatType` before `addChatParticipants` without re-deriving
 * the rule locally.
 */
export function wouldUpgradeToGroup(currentParticipantCount: number, newParticipantCount: number): boolean {
  return currentParticipantCount + newParticipantCount >= 3;
}
