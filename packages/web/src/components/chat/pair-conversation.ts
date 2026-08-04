import type { Message } from "@first-tree/shared";
import { readMentions } from "./request-state.js";

/**
 * Pair-conversation membership test shared by the Need-you earlier-chat
 * preview and the timeline message filter.
 *
 * Direct chats include every message authored by the pair; group chats
 * additionally require the message to address or reply to the other member of
 * the pair, so one side's conversations with other participants never leak
 * into the pair view.
 */
export function isPairConversationMessage({
  message,
  humanAgentId,
  otherAgentId,
  directChat,
  senderById,
}: {
  message: Message;
  humanAgentId: string;
  otherAgentId: string;
  directChat: boolean;
  /** senderId by message id over the same loaded window, for reply lookups. */
  senderById: ReadonlyMap<string, string>;
}): boolean {
  if (message.senderId !== humanAgentId && message.senderId !== otherAgentId) return false;
  if (directChat) return true;

  const counterpart = message.senderId === humanAgentId ? otherAgentId : humanAgentId;
  return (
    readMentions(message.metadata).includes(counterpart) || senderById.get(message.inReplyTo ?? "") === counterpart
  );
}

/**
 * The agents the viewer has actually conversed with in this window — each
 * non-self sender that addressed or replied to the viewer, plus everyone the
 * viewer addressed or replied to. This drives the filter's option list, so a
 * participant that only talked to other agents never becomes a filter target.
 *
 * Ordered by most recent exchange first, matching how a user thinks about
 * "the agent I'm talking to right now".
 */
export function listConversedAgentIds({
  messages,
  humanAgentId,
}: {
  messages: readonly Message[];
  humanAgentId: string;
}): string[] {
  const senderById = new Map(messages.map((message) => [message.id, message.senderId]));
  const lastExchangeAt = new Map<string, string>();
  const record = (agentId: string, at: string) => {
    if (agentId === humanAgentId) return;
    const prev = lastExchangeAt.get(agentId);
    if (!prev || at > prev) lastExchangeAt.set(agentId, at);
  };

  for (const message of messages) {
    const repliedSender = senderById.get(message.inReplyTo ?? "");
    if (message.senderId === humanAgentId) {
      for (const mention of readMentions(message.metadata)) record(mention, message.createdAt);
      if (repliedSender) record(repliedSender, message.createdAt);
      continue;
    }
    if (readMentions(message.metadata).includes(humanAgentId) || repliedSender === humanAgentId) {
      record(message.senderId, message.createdAt);
    }
  }

  return [...lastExchangeAt.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([agentId]) => agentId);
}
