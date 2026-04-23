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
 * Legacy inline shape — historical messages persisted before the
 * image-out-of-messages refactor. Still understood by the renderer but no
 * longer produced on send.
 */
export type FileMessageContent = {
  data: string; // base64 (no prefix)
  mimeType: string;
  filename: string;
  size: number;
};

/**
 * Post-refactor persisted shape. Bytes live in the sender's IndexedDB + on
 * each online agent client's local disk — never in the server DB.
 */
export type ImageRefContent = {
  imageId: string;
  mimeType: string;
  filename: string;
  size?: number;
};

/**
 * Inline shape sent over the wire. Server accepts the optional `imageId`
 * (so the sender can write to IndexedDB ahead of the POST round-trip) and
 * rewrites `content` to {@link ImageRefContent} before the DB insert.
 */
type SendFileMessageBody = FileMessageContent & { imageId?: string };

export function sendFileMessage(chatId: string, content: SendFileMessageBody): Promise<Message> {
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
