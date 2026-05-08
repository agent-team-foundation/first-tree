import type {
  AddMeChatParticipants,
  CreateMeChat,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatLeaveResponse,
  MeChatReadResponse,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

/**
 * Typed client for the chat-first workspace member APIs (`/me/chats*`).
 * Mirrors the surface in `api/me-chats.ts` on the server. Schemas live in
 * `@agent-team-foundation/first-tree-hub-shared` (`schemas/me-chat.ts`).
 *
 * Convention: keep the response shapes here aligned with the server return
 * types — server already 201-creates / 204-on-side-effect, so we surface
 * `void` for 204 routes and explicit response types for the rest.
 */

export type ListMeChatsParams = Partial<Pick<ListMeChatsQuery, "cursor" | "limit" | "filter">>;

export function listMeChats(params?: ListMeChatsParams): Promise<ListMeChatsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.filter) qs.set("filter", params.filter);
  const query = qs.toString();
  return api.get<ListMeChatsResponse>(`/me/chats${query ? `?${query}` : ""}`);
}

/**
 * Create a chat. Server always creates a NEW chat — no dedupe of direct
 * chats or exact participant sets (see design doc §"POST /me/chats").
 */
export function createMeChat(body: CreateMeChat): Promise<{ chatId: string }> {
  return api.post<{ chatId: string }>("/me/chats", body);
}

/** Mark the current user's row read. Idempotent. */
export function markMeChatRead(chatId: string): Promise<MeChatReadResponse> {
  return api.post<MeChatReadResponse>(`/me/chats/${encodeURIComponent(chatId)}/read`);
}

/** Add one or more speaking participants to a chat. Idempotent. */
export function addMeChatParticipants(chatId: string, body: AddMeChatParticipants): Promise<void> {
  return api.post<void>(`/me/chats/${encodeURIComponent(chatId)}/participants`, body);
}

/** Watcher → speaking participant. State-carry transaction on the server. */
export function joinMeChat(chatId: string): Promise<void> {
  return api.post<void>(`/me/chats/${encodeURIComponent(chatId)}/join`);
}

/** Speaking participant → watcher (or detach when no managed agent remains). */
export function leaveMeChat(chatId: string): Promise<MeChatLeaveResponse> {
  return api.post<MeChatLeaveResponse>(`/me/chats/${encodeURIComponent(chatId)}/leave`);
}
