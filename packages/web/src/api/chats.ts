import type { Chat, ChatDetail, Message } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

type PaginatedChats = {
  items: (Chat & { participantCount: number })[];
  nextCursor: string | null;
};

export type MessageWithDelivery = Message & {
  deliveryStatus?: "sent" | "pending" | "delivered" | "acked";
};

type PaginatedMessages = {
  items: MessageWithDelivery[];
  nextCursor: string | null;
};

export function listChats(params?: { limit?: number; cursor?: string }): Promise<PaginatedChats> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedChats>(`/admin/chats${query ? `?${query}` : ""}`);
}

export function getChat(chatId: string): Promise<ChatDetail> {
  return api.get<ChatDetail>(`/admin/chats/${encodeURIComponent(chatId)}`);
}

export function renameChat(chatId: string, topic: string | null): Promise<Chat> {
  return api.patch<Chat>(`/admin/chats/${encodeURIComponent(chatId)}`, { topic });
}

export function sendChatMessage(chatId: string, content: string): Promise<Message> {
  return api.post<Message>(`/admin/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "text",
    content,
  });
}

export function createAgentChat(agentUuid: string): Promise<{ id: string }> {
  return api.post<{ id: string }>(`/admin/agents/${encodeURIComponent(agentUuid)}/chats`, {});
}

export function listChatMessages(
  chatId: string,
  params?: { limit?: number; cursor?: string },
): Promise<PaginatedMessages> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedMessages>(`/admin/chats/${encodeURIComponent(chatId)}/messages${query ? `?${query}` : ""}`);
}
