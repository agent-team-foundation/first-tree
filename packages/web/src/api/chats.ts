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

/**
 * File message content — embedded directly in the message (no server-side storage).
 * `data` is a base64-encoded string (without the `data:...;base64,` prefix).
 * This keeps messages self-contained so they can be forwarded to any agent (local
 * Claude client, Kael cloud, Feishu, etc.) without requiring URL access.
 */
export type FileMessageContent = {
  data: string; // base64 (no prefix)
  mimeType: string;
  filename: string;
  size: number;
};

export function sendFileMessage(chatId: string, content: FileMessageContent): Promise<Message> {
  return api.post<Message>(`/admin/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "file",
    content,
  });
}

/** Read a File into a base64 string (without the `data:...;base64,` prefix). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      // Strip the data URL prefix: "data:image/png;base64,xxx" -> "xxx"
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
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
