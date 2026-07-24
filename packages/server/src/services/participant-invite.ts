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
 *     target's owning member ("owner-exclusive" — a manager's whole agent
 *     team acts under the manager's authority; the manager and every agent
 *     they own can invite any of the manager's private agents into a chat
 *     they themselves are already a speaker of; see RFC §4.5). Cross-
 *     manager invites of a private target are refused. Self-add
 *     (`targetAgentId === callerAgentId`) is exempt so a runtime rejoin
 *     of a private agent isn't blocked. No admin override — admin is a
 *     discovery-side affordance, not a consent-side one (an admin from
 *     a different owning member still cannot invite someone else's
 *     private agent).
 *
 *     Earlier (PR #601) this gate required the caller to be a `type=human`
 *     agent of the owning member; PR #608 relaxed back to the shared-
 *     managerId reading after a product decision that "owner's agent
 *     acts on owner's behalf" — see that PR for the deliberation
 *     transcript.
 *   - the actual write goes through `applyMembershipWrite`, which encloses
 *     the silent-context backfill + watcher recompute invariants and the
 *     post-commit audience-cache invalidation.
 */

import {
  AGENT_STATUSES,
  AGENT_TYPES,
  AGENT_VISIBILITY,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
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

export type PrivateGateCaller = {
  /** Caller agent uuid. */
  agentId: string;
  /** Caller's `agents.managerId` — the member that owns the caller. */
  memberId: string;
};

export type PrivateGateTarget = {
  uuid: string;
  /** `agents.visibility` (drizzle `text` column → `string`); compared against `AGENT_VISIBILITY.PRIVATE`. */
  visibility: string;
  managerId: string;
};

/**
 * Pure predicate: which of `targets` is the caller **NOT** allowed to bring
 * into a chat under the owner-exclusive rule for private agents?
 *
 * Rule (RFC §4.5, shared-owner reading):
 *   - target.visibility !== PRIVATE       → allowed (no gate on public agents)
 *   - target.uuid === caller.agentId      → allowed (self-add rejoin)
 *   - caller.memberId === target.managerId → allowed (owner OR any agent the
 *                                            owner owns; the manager's whole
 *                                            agent team acts under the
 *                                            manager's authority)
 *   - otherwise                            → rejected (cross-manager pull
 *                                            of a private target)
 *
 * History (don't strip — it's load-bearing for future review):
 *   - PR #601 implemented this as the **strict** reading
 *     (`caller.type === 'human' && caller.memberId === target.managerId`)
 *     to close a social-engineering path: Bob pulls owner M's PUBLIC agent
 *     X_pub into a chat, then X_pub turns around and pulls M's PRIVATE
 *     agent X_priv. The lenient reading admits X_priv there.
 *   - PR #608 reverted to this lenient reading after the product owner
 *     decided that "owner's agent acts on owner's behalf" — i.e. X_pub
 *     pulling X_priv is intentional delegation, not a social-engineering
 *     hole. Cross-manager admission of a private agent remains refused;
 *     same-manager admission via any owned agent is now intended.
 *
 * Why this lives in `participant-invite.ts` (not on a shared util): the
 * Layer-2 invite service is the canonical chat-membership gate, and
 * `createChat` / `createMeChat` run the same predicate on their initial-
 * participants set. Co-locating the rule with `inviteParticipantsToChat`
 * makes "the rule has exactly one source of truth" obvious to reviewers —
 * the duplicated-write regression that PR #550 closed was exactly this
 * kind of two-copies drift.
 *
 * Pure / no db access: callers pass the rows they already have. Errors
 * (formatting, throwing, HTTP mapping) stay with the caller so it can
 * surface the right uuids in the right error type.
 */
export function rejectedPrivateTargets(
  caller: PrivateGateCaller,
  targets: ReadonlyArray<PrivateGateTarget>,
): PrivateGateTarget[] {
  return targets.filter((t) => {
    if (t.visibility !== AGENT_VISIBILITY.PRIVATE) return false;
    if (t.uuid === caller.agentId) return false;
    return t.managerId !== caller.memberId;
  });
}

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
    .select({ id: chats.id, organizationId: chats.organizationId, metadata: chats.metadata })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  if (parseLandingCampaignTrialChatMetadata(chat.metadata)) {
    throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
  }

  // 2. Caller is a speaker. Join `chatMembership` × `agents` so we get the
  //    caller's owning-member id in the same query — the authoritative
  //    input to the owner-exclusive check below. Deriving it from
  //    `agents.managerId` (vs. accepting it as a parameter) prevents an
  //    internal caller from mismatching and bypassing the gate.
  const [callerRow] = await db
    .select({ ownerMemberId: agents.managerId, metadata: agents.metadata })
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
  if (parseLandingCampaignTrialAgentMetadata(callerRow.metadata)) {
    throw new ForbiddenError("Landing campaign trial agents cannot manage ordinary chat participants.");
  }
  const callerMemberId = callerRow.ownerMemberId;

  // 3. Targets exist + cross-org.
  const targetRows = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      visibility: agents.visibility,
      managerId: agents.managerId,
      status: agents.status,
      type: agents.type,
      memberStatus: members.status,
      metadata: agents.metadata,
    })
    .from(agents)
    .leftJoin(members, eq(members.agentId, agents.uuid))
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
  const inactiveTargets = targetRows.filter(
    (t) => t.status !== AGENT_STATUSES.ACTIVE || (t.type === AGENT_TYPES.HUMAN && t.memberStatus !== "active"),
  );
  if (inactiveTargets.length > 0) {
    throw new BadRequestError(`Inactive participant rejected: ${inactiveTargets.map((t) => t.uuid).join(", ")}`);
  }
  const trialTarget = targetRows.find((t) => parseLandingCampaignTrialAgentMetadata(t.metadata));
  if (trialTarget) {
    throw new ForbiddenError(
      `Agent "${trialTarget.uuid}" is a single-run landing campaign agent. Start it from the landing page flow.`,
    );
  }

  // 4. Owner-exclusive for private targets. The caller's owning member
  //    must match the target's owning member — i.e. the manager and any
  //    agent the manager owns share invitation rights for the manager's
  //    private agents. Cross-manager admission of a private target is
  //    refused. Self-add (target === caller) is exempt so an agent
  //    rejoining a chat it already owns isn't blocked. The actual
  //    predicate lives in `rejectedPrivateTargets` so `createChat` /
  //    `createMeChat` share the exact same rule — keeping the invariant
  //    in one place (the lesson PR #550 wrote up).
  const rejected = rejectedPrivateTargets(
    { agentId: callerAgentId, memberId: callerMemberId },
    targetRows.map((t) => ({ uuid: t.uuid, visibility: t.visibility, managerId: t.managerId })),
  );
  if (rejected.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${rejected.map((t) => t.uuid).join(", ")}`,
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
