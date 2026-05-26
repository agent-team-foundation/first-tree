import type { AgentChatStatus } from "@first-tree/shared";
import { api } from "./client.js";

/** React-Query key for one chat's composite per-agent statuses. */
export const chatAgentStatusQueryKey = (chatId: string) => ["chat-agent-status", chatId] as const;

/**
 * Composite per-agent status for a chat's non-human speakers
 * (`GET /chats/:chatId/agent-status`, Class C). One call per chat replaces
 * the old per-agent `getSession` fan-out + 10s poll; freshness rides the
 * admin WS invalidation in `use-admin-ws`.
 */
export function fetchChatAgentStatuses(chatId: string): Promise<AgentChatStatus[]> {
  return api.get<AgentChatStatus[]>(`/chats/${chatId}/agent-status`);
}
