import type {
  AttachmentRef,
  Chat,
  ChatDetail,
  ChatEngagementStatus,
  ChatGithubEntityListResponse,
  ChatGitlabEntityListResponse,
  ChatTokenUsage,
  Message,
  RequestResolution,
} from "@first-tree/shared";
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
 * Cumulative token usage for this chat — the server's SUM over every persisted
 * `token_usage` event. Resets when a session is terminated (events cleared).
 */
export function getChatTokenUsage(chatId: string): Promise<ChatTokenUsage> {
  return api.get<ChatTokenUsage>(`/chats/${encodeURIComponent(chatId)}/token-usage`);
}

/**
 * List the GitHub entities bound to this chat. The server reads its local
 * mapping projection only; state freshness comes from GitHub webhooks.
 */
export function listChatGithubEntities(chatId: string): Promise<ChatGithubEntityListResponse> {
  return api.get<ChatGithubEntityListResponse>(`/chats/${encodeURIComponent(chatId)}/github-entities`);
}

/**
 * List every GitLab entity bound to this chat, including an automatic
 * personnel-routing binding on a webhook-created chat.
 */
export function listChatGitlabEntities(chatId: string): Promise<ChatGitlabEntityListResponse> {
  return api.get<ChatGitlabEntityListResponse>(`/chats/${encodeURIComponent(chatId)}/gitlab-entities`);
}

/** Canonical human/Web unfollow contract; legacy mapping-id deletion stays server-only. */
export function unfollowChatGitlabEntity(chatId: string, entityUrl: string): Promise<{ removed: number }> {
  return api.delete<{ removed: number }>(
    `/chats/${encodeURIComponent(chatId)}/gitlab-entities?entity=${encodeURIComponent(entityUrl)}`,
  );
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

/**
 * Send a text message to a chat.
 *
 * `mentions` carries the routing intent. The server enforces explicit
 * declaration (see services/message.ts "Routing contract"): empty
 * mentions are rejected with 400, unless this is a final-text send (the
 * web composer never sends those — that's an agent-runtime path).
 *
 * Callers must derive `mentions` from the composer's chip state
 * (`extractMentions(draft, participants)` returns agent uuids) and
 * auto-inject the peer's uuid in 2-speaker chats so a bare "hi" with
 * no `@` still reaches the recipient. Passing `[]` will reach the
 * server and 400.
 */
export function sendChatMessage(
  chatId: string,
  content: string,
  mentions: string[],
  opts?: { inReplyTo?: string; resolves?: RequestResolution; attachments?: AttachmentRef[] },
): Promise<Message> {
  // `resolves` is the explicit lifecycle signal — present only when the human
  // submits a clean answer from the request card (it drives the server's
  // `open_request_count` −1 / red-dot clear). A plain "chat about this" reply
  // omits it and threads under the question without resolving it.
  //
  // `attachments` carries document/file `AttachmentRef`s on a plain text
  // message — the document-only composer send (no images). A send that also
  // carries images uses `sendFileMessageBatch` instead, which folds documents
  // into the same message's metadata.
  const attachments = opts?.attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const metadata =
    mentions.length > 0 || hasAttachments || opts?.resolves
      ? {
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(hasAttachments ? { attachments } : {}),
          ...(opts?.resolves ? { resolves: opts.resolves } : {}),
        }
      : undefined;
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "text",
    content,
    ...(metadata ? { metadata } : {}),
    ...(opts?.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
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
 * Persisted single-image shape. `imageId` is the id of an `attachments` row:
 * the composer uploads the bytes to `POST /orgs/:orgId/attachments` first,
 * then sends this reference. Every client fetches the bytes on demand from
 * `GET /attachments/:imageId` — bytes never travel in `messages.content`.
 */
export type ImageRefContent = {
  imageId: string;
  mimeType: string;
  filename: string;
  size?: number;
};

/**
 * Persisted batch shape — a caption plus N image refs, carried by a single
 * `format: "file"` message so a "caption + N images" send is one bubble.
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
 * Optional message metadata for a file send.
 * - `mentions` lets a multi-image send carry the @-mentions parsed from the
 *   user's accompanying text so the server's group-chat mention guard accepts
 *   the send. Without this, the message arrives with no addressees and is
 *   rejected before the text reaches anyone (issue 387).
 * - `attachments` carries generic {@link AttachmentRef}s (documents / files
 *   uploaded in the composer) in `message.metadata.attachments[]`. Images stay
 *   in `content` as `ImageRefContent`; a mixed send (images + documents) rides
 *   one `format: "file"` message carrying both. The server validates each ref
 *   against its stored blob (`validateMessageAttachmentRefs`).
 */
export type SendFileMessageMetadata = { mentions?: string[]; attachments?: AttachmentRef[] };

/**
 * Send a single `format: "file"` message carrying 1+ image references and an
 * optional text caption. The only image-send path — single-attachment sends
 * use this same batch shape with `attachments.length === 1`.
 *
 * The composer uploads each image's bytes to `POST /orgs/:orgId/attachments`
 * first, then sends this ref-only body. The server stores `content` verbatim;
 * every recipient fetches the bytes on demand from `GET /attachments/:id`.
 */
export type SendFileMessageBatchBody = {
  caption?: string;
  attachments: ImageRefContent[];
};

export function sendFileMessageBatch(
  chatId: string,
  content: SendFileMessageBatchBody,
  metadata?: SendFileMessageMetadata,
  opts?: { inReplyTo?: string; resolves?: RequestResolution },
): Promise<Message> {
  // Project explicit fields rather than spreading `metadata` whole so future
  // additions to SendFileMessageMetadata don't ride out on the `mentions`
  // truthiness check by accident — each new field must be opted in here.
  const mentions = metadata?.mentions;
  const hasMentions = Array.isArray(mentions) && mentions.length > 0;
  const attachments = metadata?.attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  // `resolves` rides a file-format send only when the human answers a blocking
  // ask WITH an attached image (the AskTakeover image path). The server's
  // resolution gate is format-agnostic — it authorizes off `senderId === target`
  // (services/message.ts), so a captioned image from the target resolves the
  // question exactly like a text answer. Mirrors `sendChatMessage`.
  const meta =
    hasMentions || hasAttachments || opts?.resolves
      ? {
          ...(hasMentions ? { mentions } : {}),
          ...(hasAttachments ? { attachments } : {}),
          ...(opts?.resolves ? { resolves: opts.resolves } : {}),
        }
      : undefined;
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "file",
    content,
    ...(meta ? { metadata: meta } : {}),
    // `inReplyTo` is format-agnostic threading (`sendMessageSchema`) — a
    // captioned image answering a docked question threads under it just like
    // a text reply.
    ...(opts?.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
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

/**
 * The viewer's currently-open questions (`format=request` directed at them, not
 * yet resolved) in a chat — window-independent, so the blocking answer UI can
 * surface an open ask that has scrolled past the latest message page.
 */
export function listChatOpenRequests(chatId: string): Promise<{ items: Message[] }> {
  return api.get<{ items: Message[] }>(`/chats/${encodeURIComponent(chatId)}/open-requests`);
}
