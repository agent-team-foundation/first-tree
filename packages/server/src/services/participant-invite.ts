/**
 * Single Layer-2 entry for "speaker A invites agent B (or many Bs) into chat C".
 *
 * Both the agent-JWT path (`chat.ts::addParticipant` — single target by uuid
 * or by name) and the user-JWT web path (`me-chat.ts::addMeChatParticipants`
 * — batch by uuid) collapse onto this service. The previous arrangement —
 * two near-identical services with mirrored cross-org / owner-exclusive
 * checks — is what let PR #393's silent-context backfill regress when the
 * web path drifted past the agent path (see PR #545 + follow-up). Anchoring
 * the invite rules to a single function closes the whole class of
 * "duplicate writers go out of sync" bug.
 *
 * Caller-side adapter shells (Layer 3) keep their wire-shape responsibilities:
 *   - `chat.ts::addParticipant` resolves a single `{ agentId | agentName }`
 *     to a uuid, then calls this service with `targetAgentIds: [uuid]` and
 *     `errorOnAlreadySpeaker: true` (the agent SDK contract treats "already
 *     in the chat" as a hard 409 with a recognisable name).
 *   - `me-chat.ts::addMeChatParticipants` does the web-path "chat in caller's
 *     org" probing-protection 404 pre-check, then calls this service with
 *     `targetAgentIds: body.participantIds` and `errorOnAlreadySpeaker:
 *     false` (the batch UI is partial-idempotent: re-adding someone already
 *     in the chat is silent).
 *
 * What this service does NOT do — by design:
 *   - by-name target lookup (Layer 3 concern; only the agent-JWT path
 *     surfaces it)
 *   - probing-protection 404 swap (Layer 3 concern; only the web path
 *     surfaces it, see `assertChatVisibleInOrg` for the helper)
 *   - return shape (Layer 3 chooses what to read back, if anything)
 *
 * Hard-wired contract here:
 *   - caller MUST be a chat speaker (else `CallerNotSpeakerError`, a
 *     subclass of `ForbiddenError`) — the only authorisation gate; no admin
 *     override path (admins use the same chat-membership rows as everyone
 *     else). Web shells match on the subclass to remap into 404
 *     probing-protection; do NOT downgrade the throw site to a plain
 *     `ForbiddenError` without updating those callers in lockstep.
 *   - every target must exist (else BadRequestError listing the missing
 *     ids).
 *   - every target must be in the chat's organization (else BadRequestError).
 *   - private targets only land if the caller's owning member matches the
 *     target's owning member ("owner-exclusive" / "邀请即同意"; see
 *     `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.4.2 / §4.5).
 *     Self-add (`targetAgentId === callerAgentId`) is exempt.
 *   - the actual write goes through `applyMembershipWrite`, which encloses
 *     the silent-context backfill + watcher recompute invariants and the
 *     post-commit audience-cache invalidation.
 */

import { AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { BadRequestError, CallerNotSpeakerError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { applyMembershipWrite } from "./participant-mode.js";

export type InviteParticipantsArgs = {
  chatId: string;
  /** Caller agent uuid. MUST currently be a speaker of the chat. */
  callerAgentId: string;
  /** Targets to invite, by uuid. by-name resolution is a Layer-3 concern. */
  targetAgentIds: ReadonlyArray<string>;
  /**
   * Behaviour for targets that already hold an `access_mode='speaker'` row
   * in the chat:
   *   - `true`  → throw `ConflictError` on the first such target. Used by
   *               the agent-JWT path where the wire contract is "one target,
   *               409 if already in".
   *   - `false` → silently skip the already-speaker targets and proceed with
   *               the rest. Used by the web batch path which is partial-
   *               idempotent (the UI treats re-adding someone as a no-op).
   *
   * Either way, the underlying `addChatParticipants` call is already
   * idempotent on already-speaker rows — this flag controls only whether
   * the service surfaces a 409 to the caller.
   */
  errorOnAlreadySpeaker: boolean;
};

/**
 * Invite one or more agents into a chat. See the file-level comment for the
 * contract and the rationale for which checks live here vs. in Layer-3
 * adapter shells.
 */
export async function inviteParticipantsToChat(db: Database, args: InviteParticipantsArgs): Promise<void> {
  const { chatId, callerAgentId, targetAgentIds, errorOnAlreadySpeaker } = args;
  const distinctTargets = [...new Set(targetAgentIds)];
  if (distinctTargets.length === 0) {
    throw new BadRequestError("At least one participant required");
  }

  // 1. Chat exists.
  const [chat] = await db
    .select({ id: chats.id, organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }

  // 2. Caller is a speaker. Join `chatMembership` × `agents` so we get the
  //    caller's owning-member id in the same query — it's the authoritative
  //    input to the owner-exclusive check below. Deriving it from the
  //    caller's `managerId` (vs. accepting it as a parameter) prevents an
  //    internal caller from mismatching the two and bypassing the gate.
  const [callerRow] = await db
    .select({ ownerMemberId: agents.managerId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, callerAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!callerRow) {
    throw new CallerNotSpeakerError(callerAgentId, chatId);
  }
  const callerMemberId = callerRow.ownerMemberId;

  // 3. Targets exist + cross-org.
  const targetRows = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      visibility: agents.visibility,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(inArray(agents.uuid, distinctTargets));
  if (targetRows.length !== distinctTargets.length) {
    const foundSet = new Set(targetRows.map((r) => r.uuid));
    const missing = distinctTargets.filter((id) => !foundSet.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }
  const crossOrg = targetRows.filter((t) => t.organizationId !== chat.organizationId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization participant rejected: ${crossOrg.map((t) => t.uuid).join(", ")}`);
  }

  // 4. Owner-exclusive for private targets. Self-add (target === caller) is
  //    exempt so an agent rejoining a chat it already owns isn't blocked.
  const privateNotOwned = targetRows.filter(
    (t) => t.visibility === AGENT_VISIBILITY.PRIVATE && t.uuid !== callerAgentId && t.managerId !== callerMemberId,
  );
  if (privateNotOwned.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${privateNotOwned.map((t) => t.uuid).join(", ")}`,
    );
  }

  // 5. Already-speaker behaviour. `addChatParticipants` is naturally
  //    idempotent on already-speaker rows (it identifies them and skips the
  //    backfill); this flag only controls whether the service raises a 409
  //    to the caller.
  const existingSpeakers = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        inArray(chatMembership.agentId, distinctTargets),
        eq(chatMembership.accessMode, "speaker"),
      ),
    );
  const existingSpeakerSet = new Set(existingSpeakers.map((e) => e.agentId));
  if (errorOnAlreadySpeaker) {
    const firstDup = distinctTargets.find((id) => existingSpeakerSet.has(id));
    if (firstDup !== undefined) {
      throw new ConflictError(`Agent "${firstDup}" is already a participant`);
    }
  }
  const toWrite = distinctTargets.filter((id) => !existingSpeakerSet.has(id));
  if (toWrite.length === 0) {
    // All targets were already speakers and the caller opted into silent
    // skip. No row write needed; the watcher set is already consistent with
    // the speaker set (the most recent write that put these agents in has
    // already run recompute). Skip the round-trip.
    return;
  }

  // 6. Delegate to the canonical write bundle. `upgradeWatcherToSpeaker:
  //    true` lets a pre-existing watcher row be promoted in place; for
  //    brand-new targets it's a regular INSERT.
  await applyMembershipWrite(
    db,
    chatId,
    toWrite.map((agentId) => ({ agentId, role: "member" as const })),
    { upgradeWatcherToSpeaker: true },
  );
}

/**
 * Web-path probing-protection helper. Web callers must not be able to learn
 * "this chat exists but you can't see it" — both "chat doesn't exist" and
 * "chat exists but not in your org" surface as the same 404.
 *
 * Used by the `me-chat.ts::addMeChatParticipants` shell (and any other web
 * entrypoint that wants the same shape) before delegating to
 * `inviteParticipantsToChat`. Kept here so the assertion lives next to the
 * service whose error semantics it adjusts.
 */
export async function assertChatVisibleInOrgOrNotFound(
  db: Database,
  chatId: string,
  callerOrganizationId: string,
): Promise<void> {
  const [chat] = await db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat || chat.organizationId !== callerOrganizationId) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
}
