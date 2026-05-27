import type { Chat, ChatDetail, ChatEngagementStatus, ChatGithubEntityListResponse, Message } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

type PaginatedChats = {
  items: (Chat & { participantCount: number })[];
  nextCursor: string | null;
};

export type MessageWithDelivery = Message & {
  deliveryStatus?: "sent" | "pending" | "delivered" | "acked";
};

export type PaginatedMessages = {
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
 * Inline shape sent over the wire for one attachment. Server accepts the
 * optional `imageId` (so the sender can write to IndexedDB ahead of the POST
 * round-trip) and rewrites the persisted `content` to {@link ImageRefContent}
 * before the DB insert. Used as the array element of
 * {@link SendFileMessageBatchBody.attachments}.
 */
export type SendFileMessageBody = FileMessageContent & { imageId?: string };

/**
 * Post-refactor persisted batch shape — what `format: "file"` messages
 * carry on the wire when a composer sends a caption together with N image
 * attachments in one send. The server rewrites inline batch bodies to this
 * shape after extracting the bytes (see `prepareImageOutbound`).
 *
 * Old single-image messages (whose `content` is just an `ImageRefContent`)
 * keep working — renderers detect the batch shape via `attachments` being
 * an array and fall through to the legacy branch otherwise.
 */
export type ImageBatchRefContent = {
  caption?: string;
  attachments: ImageRefContent[];
};

/**
 * Optional message metadata for a file send. Today only `mentions` is wired
 * — it lets a multi-image send carry the @-mentions parsed from the user's
 * accompanying text so the server's group-chat mention guard accepts the
 * send. Without this, the message arrives with no addressees and is
 * rejected before the text reaches anyone (issue 387).
 */
export type SendFileMessageMetadata = { mentions?: string[] };

/**
 * Send a single `format: "file"` message carrying 1+ image attachments and
 * an optional text caption. The only image-send path — single-attachment
 * sends use this same batch shape with `attachments.length === 1`.
 *
 * Server intercepts each attachment's bytes, pushes one `image_payload`
 * frame per attachment (clients keep their per-imageId disk-write path),
 * and rewrites `content` to the persisted {@link ImageBatchRefContent}
 * shape before insert.
 */
export type SendFileMessageBatchBody = {
  caption?: string;
  attachments: SendFileMessageBody[];
};

export function sendFileMessageBatch(
  chatId: string,
  content: SendFileMessageBatchBody,
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
