import type { Chat, ChatDetail, Message } from "@first-tree-core/shared";
import { api } from "./client.js";

type PaginatedChats = {
  items: (Chat & { participantCount: number })[];
  nextCursor: string | null;
};

type PaginatedMessages = {
  items: Message[];
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
