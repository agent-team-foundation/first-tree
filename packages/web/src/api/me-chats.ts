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
 * Typed client for the chat-first workspace chat APIs.
 *
 * Class B (`/orgs/:orgId/chats`) — list / create. The api-client
 * `decoratePath` automatically prefixes the selected org id, so call sites
 * stay readable as `/chats`.
 *
 * Class C (`/chats/:chatId/...`) — per-chat operations. The chat's UUID
 * is org-locating on the server side; no org prefix needed.
 */

export type ListMeChatsParams = Partial<Pick<ListMeChatsQuery, "cursor" | "limit" | "filter">>;

export function listMeChats(params?: ListMeChatsParams): Promise<ListMeChatsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.filter) qs.set("filter", params.filter);
  const query = qs.toString();
  return api.get<ListMeChatsResponse>(`/chats${query ? `?${query}` : ""}`);
}

export function createMeChat(body: CreateMeChat): Promise<{ chatId: string }> {
  return api.post<{ chatId: string }>("/chats", body);
}

export function markMeChatRead(chatId: string): Promise<MeChatReadResponse> {
  return api.post<MeChatReadResponse>(`/chats/${encodeURIComponent(chatId)}/read`);
}

export function addMeChatParticipants(chatId: string, body: AddMeChatParticipants): Promise<void> {
  return api.post<void>(`/chats/${encodeURIComponent(chatId)}/participants`, body);
}

export function joinMeChat(chatId: string): Promise<void> {
  return api.post<void>(`/chats/${encodeURIComponent(chatId)}/workspace-join`);
}

export function leaveMeChat(chatId: string): Promise<MeChatLeaveResponse> {
  return api.post<MeChatLeaveResponse>(`/chats/${encodeURIComponent(chatId)}/workspace-leave`);
}
