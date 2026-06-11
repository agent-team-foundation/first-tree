import { AGENT_STATUSES } from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { BadRequestError } from "../errors.js";

export type MessageRecipientSpeaker = {
  agentId: string;
  name?: string | null;
  displayName?: string | null;
  status: string;
  type?: string | null;
};

export type MessageRecipientRouting = {
  mergedMentions: string[];
  speakersById: Map<string, MessageRecipientSpeaker>;
  activeRecipientIds: Set<string>;
};

type ResolveMessageRecipientRoutingOptions = {
  notParticipantMessage?: (agentId: string) => string;
  inactiveMessage?: (speaker: MessageRecipientSpeaker) => string;
  allowMissingAddressedToAgentIds?: boolean;
};

function defaultNotParticipantMessage(agentId: string): string {
  return `Cannot route to "${agentId}" because they are not a participant of this chat.`;
}

function defaultInactiveMessage(speaker: MessageRecipientSpeaker): string {
  const label = speaker.displayName || speaker.name || speaker.agentId;
  const recovery =
    speaker.status === AGENT_STATUSES.SUSPENDED
      ? "Reactivate it before sending."
      : "Deleted agents cannot receive new messages.";
  return `Cannot route to "${label}" because the agent is ${speaker.status}. ${recovery}`;
}

export function explicitRecipientRequiredMessage(): string {
  return (
    "Sending a message requires an explicit recipient. " +
    "Pass `metadata.mentions: [agentId]` (or `receiverNames: [name]`) to declare routing, " +
    'or set `purpose: "agent-final-text"` for silent history-only sends.'
  );
}

export function resolveMessageRecipientRouting(
  senderId: string,
  speakers: ReadonlyArray<MessageRecipientSpeaker>,
  input: {
    explicitMentions?: ReadonlyArray<string>;
    receiverNames?: ReadonlyArray<string>;
    addressedToAgentIds?: ReadonlyArray<string>;
  },
  options: ResolveMessageRecipientRoutingOptions = {},
): MessageRecipientRouting {
  const speakersById = new Map(speakers.map((speaker) => [speaker.agentId, speaker]));
  const speakersByName = new Map<string, string>();
  for (const speaker of speakers) {
    if (speaker.name) speakersByName.set(speaker.name.toLowerCase(), speaker.agentId);
  }

  const resolvedFromNames: string[] = [];
  const unresolvedNames: string[] = [];
  for (const name of input.receiverNames ?? []) {
    const id = speakersByName.get(name.toLowerCase());
    if (id) resolvedFromNames.push(id);
    else unresolvedNames.push(name);
  }
  if (unresolvedNames.length > 0) {
    const sample = unresolvedNames[0];
    throw new BadRequestError(
      `Cannot route to "${sample}" — they are not a participant of this chat. ` +
        "Add them first:\n" +
        `  ${getServerCliBinding().binName} chat invite ${sample}\n` +
        "Then retry your send. Or ask a human in this chat to add them.",
    );
  }

  const mergedMentions = [...new Set([...(input.explicitMentions ?? []), ...resolvedFromNames])];
  const activeRecipientIds = new Set<string>();
  const notParticipantMessage = options.notParticipantMessage ?? defaultNotParticipantMessage;
  const inactiveMessage = options.inactiveMessage ?? defaultInactiveMessage;

  for (const id of mergedMentions) {
    if (id === senderId) continue;
    const speaker = speakersById.get(id);
    if (!speaker) {
      throw new BadRequestError(notParticipantMessage(id));
    }
    if (speaker.status !== AGENT_STATUSES.ACTIVE) {
      throw new BadRequestError(inactiveMessage(speaker));
    }
    activeRecipientIds.add(id);
  }

  for (const id of input.addressedToAgentIds ?? []) {
    if (id === senderId) continue;
    const speaker = speakersById.get(id);
    if (!speaker) {
      if (options.allowMissingAddressedToAgentIds) continue;
      throw new BadRequestError(notParticipantMessage(id));
    }
    if (speaker.status !== AGENT_STATUSES.ACTIVE) {
      throw new BadRequestError(inactiveMessage(speaker));
    }
    activeRecipientIds.add(id);
  }

  return { mergedMentions, speakersById, activeRecipientIds };
}

export function assertHasActiveRecipient(routing: MessageRecipientRouting, message?: string): void {
  if (routing.activeRecipientIds.size === 0) {
    throw new BadRequestError(message ?? explicitRecipientRequiredMessage());
  }
}
