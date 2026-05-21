import type {
  AttachmentRef,
  Chat,
  ChatDetail,
  ChatEngagementStatus,
  ChatGithubEntityListResponse,
  Message,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api, apiFetchBlob, apiUpload, withOrg } from "./client.js";

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
  return api.get<PaginatedChats>(withOrg(`/chats${query ? `?${query}` : ""}`));
}

export function getChat(chatId: string): Promise<ChatDetail> {
  return api.get<ChatDetail>(`/chats/${encodeURIComponent(chatId)}`);
}

/**
 * List the GitHub entities bound to this chat. Server fetches live state
 * from GitHub on every request — nothing is cached server-side — so the
 * client should rely on React Query's `staleTime` to keep this gentle.
 */
export function listChatGithubEntities(chatId: string): Promise<ChatGithubEntityListResponse> {
  return api.get<ChatGithubEntityListResponse>(`/chats/${encodeURIComponent(chatId)}/github-entities`);
}

export function renameChat(chatId: string, topic: string | null): Promise<Chat> {
  return api.patch<Chat>(`/chats/${encodeURIComponent(chatId)}`, { topic });
}

/**
 * Set the caller's engagement state for this chat. Per-user — writes the
 * caller's `chat_user_state` row only. All transitions are legal, including
 * `deleted → active` (Restore from the chat detail view).
 */
export function patchChatEngagement(
  chatId: string,
  status: ChatEngagementStatus,
): Promise<{ chatId: string; engagementStatus: ChatEngagementStatus }> {
  return api.post(`/chats/${encodeURIComponent(chatId)}/engagement`, { status });
}

export function sendChatMessage(chatId: string, content: string): Promise<Message> {
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "text",
    content,
  });
}

/**
 * Upload one file to a chat (route 2 / PG-bytea). Returns the persisted
 * {@link AttachmentRef}; the composer collects these and sends a single message
 * referencing them via `attachmentIds`. The server runs the type double-gate +
 * quota and leaves the row unbound until the send binds it.
 */
export function uploadChatAttachment(chatId: string, file: File): Promise<AttachmentRef> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiUpload<AttachmentRef>(`/chats/${encodeURIComponent(chatId)}/attachments`, form);
}

/**
 * Send one message carrying a text caption (may be empty) + previously-uploaded
 * attachments (A′: refs ride `metadata.attachments`, no new format). The server
 * validates each attachmentId belongs to the sender and is unbound (C3).
 */
export function sendChatMessageWithAttachments(
  chatId: string,
  args: { text: string; attachmentIds: string[] },
): Promise<Message> {
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "text",
    content: args.text,
    attachmentIds: args.attachmentIds,
  });
}

/** Authenticated path of a chat attachment's download route (for fetch→blob). */
export function chatAttachmentPath(chatId: string, attachmentId: string): string {
  return `/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Fetch an attachment's bytes as a Blob (authenticated) for inline rendering / download. */
export function fetchChatAttachmentBlob(chatId: string, attachmentId: string): Promise<Blob> {
  return apiFetchBlob(chatAttachmentPath(chatId, attachmentId));
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

/**
 * Optional message metadata for a file send. Today only `mentions` is wired
 * — it lets a multi-image send carry the @-mentions parsed from the user's
 * accompanying text so the server's group-chat mention guard accepts each
 * image POST. Without this, the image messages arrive with no addressees and
 * are rejected before the text is sent (issue 387).
 */
export type SendFileMessageMetadata = { mentions?: string[] };

export function sendFileMessage(
  chatId: string,
  content: SendFileMessageBody,
  metadata?: SendFileMessageMetadata,
): Promise<Message> {
  // Project explicit fields rather than spreading `metadata` whole so future
  // additions to SendFileMessageMetadata don't ride out on the `mentions`
  // truthiness check by accident — each new field must be opted in here.
  const mentions = metadata?.mentions;
  const hasMentions = Array.isArray(mentions) && mentions.length > 0;
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "file",
    content,
    ...(hasMentions ? { metadata: { mentions } } : {}),
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
  return api.post<{ id: string }>(`/agents/${encodeURIComponent(agentUuid)}/chats`, {});
}

export function listChatMessages(
  chatId: string,
  params?: { limit?: number; cursor?: string },
): Promise<PaginatedMessages> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedMessages>(`/chats/${encodeURIComponent(chatId)}/messages${query ? `?${query}` : ""}`);
}
