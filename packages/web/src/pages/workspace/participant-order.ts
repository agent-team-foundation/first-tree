import type { AgentChatStatus, ChatParticipantDetail } from "@first-tree/shared";

export const VISIBLE_LIMIT = 5;

export type ParticipantActivityMessage = {
  senderId: string;
  createdAt: string;
};

function isActiveAgent(
  participant: ChatParticipantDetail,
  status: AgentChatStatus | null,
  liveTurnAgentIds: ReadonlySet<string>,
): boolean {
  if (participant.type === "human") return false;
  return liveTurnAgentIds.has(participant.agentId) || status?.working === true || status?.main === "working";
}

/**
 * Rank the chat-local roster by what matters in the conversation:
 * currently-working agents first, then the most recent speakers, then the
 * server's stable membership order for ties/no-activity rows.
 */
export function orderParticipantsByActivity(
  participants: ChatParticipantDetail[],
  messages: ReadonlyArray<ParticipantActivityMessage>,
  statuses: ReadonlyArray<AgentChatStatus> = [],
  liveTurnAgentIds: ReadonlySet<string> = new Set(),
): ChatParticipantDetail[] {
  const originalIndex = new Map<string, number>();
  participants.forEach((p, idx) => {
    originalIndex.set(p.agentId, idx);
  });

  const latestActivity = new Map<string, string>();
  for (const message of messages) {
    const previous = latestActivity.get(message.senderId);
    if (!previous || previous.localeCompare(message.createdAt) < 0) {
      latestActivity.set(message.senderId, message.createdAt);
    }
  }

  const statusByAgent = new Map(statuses.map((status) => [status.agentId, status]));

  return [...participants].sort((a, b) => {
    const aActive = isActiveAgent(a, statusByAgent.get(a.agentId) ?? null, liveTurnAgentIds);
    const bActive = isActiveAgent(b, statusByAgent.get(b.agentId) ?? null, liveTurnAgentIds);
    if (aActive !== bActive) return aActive ? -1 : 1;

    const aActivity = latestActivity.get(a.agentId);
    const bActivity = latestActivity.get(b.agentId);
    if (aActivity && bActivity && aActivity !== bActivity) return bActivity.localeCompare(aActivity);
    if (aActivity !== bActivity) return aActivity ? -1 : 1;

    return (originalIndex.get(a.agentId) ?? 0) - (originalIndex.get(b.agentId) ?? 0);
  });
}

export function partitionRoster(
  participants: ChatParticipantDetail[],
  showAll: boolean,
  limit: number = VISIBLE_LIMIT,
): {
  total: number;
  visibleParticipants: ChatParticipantDetail[];
  hiddenCount: number;
} {
  const total = participants.length;
  const visibleParticipants = showAll ? participants : participants.slice(0, limit);
  return {
    total,
    visibleParticipants,
    hiddenCount: total - visibleParticipants.length,
  };
}
