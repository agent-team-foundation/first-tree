import type { Chat, ChatDetail, Message } from "@agent-team-foundation/first-tree-hub-shared";
import { api, getStoredTokens } from "./client.js";

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

export type UploadResult = {
  url: string;
  filename: string;
  storedName: string;
  mimeType: string;
  size: number;
};

export type FileMessageContent = {
  url: string;
  mimeType: string;
  filename: string;
  size: number;
};

export async function uploadFile(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const doFetch = (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch("/api/v1/admin/uploads", { method: "POST", headers, body: formData });
  };

  const tokens = getStoredTokens();
  let res = await doFetch(tokens?.accessToken);

  // Retry with refreshed token on 401
  if (res.status === 401 && tokens?.refreshToken) {
    const refreshRes = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (refreshRes.ok) {
      const body = (await refreshRes.json()) as { accessToken: string; refreshToken?: string };
      const updated = { accessToken: body.accessToken, refreshToken: body.refreshToken ?? tokens.refreshToken };
      // Re-create FormData since the previous body was consumed
      const retryData = new FormData();
      retryData.append("file", file);
      res = await fetch("/api/v1/admin/uploads", {
        method: "POST",
        headers: { Authorization: `Bearer ${updated.accessToken}` },
        body: retryData,
      });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    let msg: string;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      msg = text;
    }
    throw new Error(msg);
  }

  return (await res.json()) as UploadResult;
}

export function sendFileMessage(chatId: string, content: FileMessageContent): Promise<Message> {
  return api.post<Message>(`/admin/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "file",
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
