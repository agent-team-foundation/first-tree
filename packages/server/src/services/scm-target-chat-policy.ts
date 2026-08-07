import { AGENT_STATUSES, AGENT_TYPES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import {
  type LockedChatSpeakerSnapshot,
  lockChatMembershipMutation,
  lockChatSpeakerAndAgentSnapshot,
} from "./chat-membership-lock.js";
import { canInviteParticipantsToChatInTransaction } from "./participant-invite.js";

export type ScmTargetChatDecision =
  | { kind: "reuse_membership"; chatId: string }
  | { kind: "reuse_with_line"; chatId: string; admitWakeAgent: boolean }
  | { kind: "strict_new_line" };

type AgentSnapshot = {
  uuid: string;
  organizationId: string;
  type: string;
  status: string;
  managerId: string;
  delegateMention: string | null;
};

export type ScmPersonnelAuthority = {
  humanAgentId: string;
  wakeAgentId: string;
  organizationId: string;
  ownerMemberId: string;
  wakeOwnerMemberId: string;
};

export type LockedScmPersonnelPlacement = {
  authority: ScmPersonnelAuthority;
  speakerSnapshot: LockedChatSpeakerSnapshot;
};

/**
 * Lock and revalidate personnel authority plus candidate speakers without
 * expanding an already-held pair lock. The membership fence comes first,
 * then the human member row, then one UUID-sorted union of the target pair
 * and every candidate speaker agent row.
 */
export async function lockAndValidateScmPersonnelPlacement(
  db: Database,
  input: { humanAgentId: string; wakeAgentId: string; candidateChatIds: string[] },
): Promise<LockedScmPersonnelPlacement | null> {
  const candidateChatIds = [...new Set(input.candidateChatIds)].sort();
  await lockChatMembershipMutation(db, candidateChatIds);

  // Match the global membership lifecycle order: members before agent mirrors.
  const [humanMember] = await db
    .select({ id: members.id, status: members.status })
    .from(members)
    .where(eq(members.agentId, input.humanAgentId))
    .for("update")
    .limit(1);

  const lockedSnapshot = await lockChatSpeakerAndAgentSnapshot(db, candidateChatIds, [
    input.humanAgentId,
    input.wakeAgentId,
  ]);
  const pairById = new Map(
    lockedSnapshot.agents.map((row) => [row.agentId, { ...row, uuid: row.agentId }] satisfies [string, AgentSnapshot]),
  );
  const human = pairById.get(input.humanAgentId);
  const wake = pairById.get(input.wakeAgentId);
  if (!human || !wake) return null;
  if (
    !isCurrentEligiblePair(human, wake, input.wakeAgentId, humanMember?.status ?? null) ||
    human.managerId !== humanMember?.id
  ) {
    return null;
  }
  return {
    authority: {
      humanAgentId: input.humanAgentId,
      wakeAgentId: input.wakeAgentId,
      organizationId: human.organizationId,
      ownerMemberId: human.managerId,
      wakeOwnerMemberId: wake.managerId,
    },
    speakerSnapshot: {
      chats: lockedSnapshot.chats,
      speakers: lockedSnapshot.speakers,
    },
  };
}

/**
 * Select a personnel target's chat without merging attention identities.
 *
 * The caller holds the provider/entity attention lock and supplies the
 * transaction-stable speaker snapshot produced with the authority lock set.
 */
export async function decideScmPersonnelTargetChat(
  db: Database,
  input: {
    requiresPersistentLine: boolean;
    candidateChatIds: string[];
    humanAgentId: string;
    wakeAgentId: string;
    authority: ScmPersonnelAuthority;
    speakerSnapshot: LockedChatSpeakerSnapshot;
  },
): Promise<ScmTargetChatDecision> {
  const authority = input.authority;
  if (authority.humanAgentId !== input.humanAgentId || authority.wakeAgentId !== input.wakeAgentId) {
    throw new Error("SCM personnel authority does not match the target pair");
  }
  const candidateChatIds = [...new Set(input.candidateChatIds)].sort();
  if (candidateChatIds.length === 0) return { kind: "strict_new_line" };

  const lockedSnapshot = input.speakerSnapshot;
  const chatById = new Map(lockedSnapshot.chats.map((chat) => [chat.id, chat]));
  const speakerRows = lockedSnapshot.speakers;
  const speakersByChat = new Map<string, typeof speakerRows>();
  for (const row of speakerRows) {
    const current = speakersByChat.get(row.chatId);
    if (current) current.push(row);
    else speakersByChat.set(row.chatId, [row]);
  }

  const exactMembershipChats = candidateChatIds.filter((chatId) => {
    const chat = chatById.get(chatId);
    if (!chat || chat.organizationId !== authority.organizationId) return false;
    const speakerIds = new Set((speakersByChat.get(chatId) ?? []).map((speaker) => speaker.agentId));
    return speakerIds.has(input.humanAgentId) && speakerIds.has(input.wakeAgentId);
  });
  if (exactMembershipChats.length > 1) return { kind: "strict_new_line" };
  const exactMembershipChat = exactMembershipChats[0];
  if (exactMembershipChat) {
    return input.requiresPersistentLine
      ? { kind: "reuse_with_line", chatId: exactMembershipChat, admitWakeAgent: false }
      : { kind: "reuse_membership", chatId: exactMembershipChat };
  }
  if (!input.requiresPersistentLine) return { kind: "strict_new_line" };
  if (authority.wakeOwnerMemberId !== authority.ownerMemberId) return { kind: "strict_new_line" };
  const ownerPrivateChats: string[] = [];
  for (const chatId of candidateChatIds) {
    const chat = chatById.get(chatId);
    if (!chat || chat.organizationId !== authority.organizationId) continue;
    const speakers = speakersByChat.get(chatId) ?? [];
    const humanSpeakers = speakers.filter((speaker) => speaker.type === AGENT_TYPES.HUMAN);
    if (humanSpeakers.length !== 1 || humanSpeakers[0]?.agentId !== input.humanAgentId) continue;
    if (
      speakers.some((speaker) => speaker.type !== AGENT_TYPES.HUMAN && speaker.managerId !== authority.ownerMemberId)
    ) {
      continue;
    }
    const canAdmit = await canInviteParticipantsToChatInTransaction(db, {
      chatId,
      callerAgentId: input.humanAgentId,
      targetAgentIds: [input.wakeAgentId],
      errorOnAlreadySpeaker: false,
    });
    if (canAdmit) ownerPrivateChats.push(chatId);
    if (ownerPrivateChats.length > 1) return { kind: "strict_new_line" };
  }
  const ownerPrivateChat = ownerPrivateChats[0];
  return ownerPrivateChat
    ? { kind: "reuse_with_line", chatId: ownerPrivateChat, admitWakeAgent: true }
    : { kind: "strict_new_line" };
}

function isCurrentEligiblePair(
  human: AgentSnapshot,
  wake: AgentSnapshot,
  wakeAgentId: string,
  humanMemberStatus: string | null,
): boolean {
  return Boolean(
    human.type === AGENT_TYPES.HUMAN &&
      human.status === AGENT_STATUSES.ACTIVE &&
      humanMemberStatus === "active" &&
      human.delegateMention === wakeAgentId &&
      wake.type !== AGENT_TYPES.HUMAN &&
      wake.status === AGENT_STATUSES.ACTIVE &&
      human.organizationId === wake.organizationId,
  );
}
