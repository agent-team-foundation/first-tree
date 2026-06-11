/**
 * Helpers that turn domain objects (messages, inbox entries, chats, agents,
 * adapters) into a consistent set of span attribute records.
 *
 * Cross-async trace continuity in First Tree relies on *attribute matching* in the
 * trace backend rather than on parent-span linking (see
 * `proposals/hub-observability.20260420.md` for rationale). These helpers
 * guarantee that enqueue / deliver / push / adapter-outbound all stamp the
 * same key set for the same domain object so a single query in Logfire /
 * Honeycomb (e.g. `inbox.entry.id = "..."`) reconstructs the journey.
 */

import { FIRST_TREE_ATTR } from "@first-tree/shared/observability";

type Attrs = Record<string, unknown>;

export function messageAttrs(msg: { id?: string; chatId?: string; source?: string; senderAgentId?: string }): Attrs {
  const out: Attrs = {};
  if (msg.id) out[FIRST_TREE_ATTR.MESSAGE_ID] = msg.id;
  if (msg.chatId) out[FIRST_TREE_ATTR.CHAT_ID] = msg.chatId;
  if (msg.source) out[FIRST_TREE_ATTR.MESSAGE_SOURCE] = msg.source;
  if (msg.senderAgentId) out[FIRST_TREE_ATTR.AGENT_ID] = msg.senderAgentId;
  return out;
}

export function inboxAttrs(entry: {
  id?: string | number;
  messageId?: string;
  agentId?: string;
  status?: string;
  retryCount?: number;
}): Attrs {
  const out: Attrs = {};
  if (entry.id !== undefined && entry.id !== null) {
    out[FIRST_TREE_ATTR.INBOX_ENTRY_ID] = String(entry.id);
  }
  if (entry.messageId) out[FIRST_TREE_ATTR.MESSAGE_ID] = entry.messageId;
  if (entry.agentId) out[FIRST_TREE_ATTR.AGENT_ID] = entry.agentId;
  if (entry.status) out[FIRST_TREE_ATTR.INBOX_STATUS] = entry.status;
  if (entry.retryCount !== undefined) out[FIRST_TREE_ATTR.INBOX_ATTEMPT] = entry.retryCount;
  return out;
}

export function chatAttrs(chat: { id?: string; type?: string; organizationId?: string }): Attrs {
  const out: Attrs = {};
  if (chat.id) out[FIRST_TREE_ATTR.CHAT_ID] = chat.id;
  if (chat.type) out[FIRST_TREE_ATTR.CHAT_TYPE] = chat.type;
  if (chat.organizationId) out[FIRST_TREE_ATTR.ORGANIZATION_ID] = chat.organizationId;
  return out;
}

export function agentAttrs(agent: { uuid?: string; id?: string; organizationId?: string; clientId?: string }): Attrs {
  const out: Attrs = {};
  const id = agent.uuid ?? agent.id;
  if (id) out[FIRST_TREE_ATTR.AGENT_ID] = id;
  if (agent.organizationId) out[FIRST_TREE_ATTR.ORGANIZATION_ID] = agent.organizationId;
  if (agent.clientId) out[FIRST_TREE_ATTR.CLIENT_ID] = agent.clientId;
  return out;
}
