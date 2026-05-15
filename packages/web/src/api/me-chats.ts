import type {
  AddMeChatParticipants,
  ChatEngagementView,
  CreateMeChat,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatLeaveResponse,
  MeChatReadResponse,
  MeChatSourceCounts,
  MeChatUnreadResponse,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

/**
 * Typed client for the chat-first workspace chat APIs.
 *
 * Org-scoped list / create endpoints (`/chats`, `/chats?...`) wrap with
 * `withOrg` so the path resolves against the currently-selected org.
 * Per-chat operations (`/chats/:chatId/...`) are sent verbatim — the
 * chat's UUID is enough for the server to resolve the owning org.
 */

export type ListMeChatsParams = Partial<
  Pick<ListMeChatsQuery, "cursor" | "limit" | "filter" | "engagement" | "source">
>;

export function listMeChats(params?: ListMeChatsParams): Promise<ListMeChatsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.filter) qs.set("filter", params.filter);
  if (params?.engagement) qs.set("engagement", params.engagement);
  if (params?.source) qs.set("source", params.source);
  const query = qs.toString();
  return api.get<ListMeChatsResponse>(withOrg(`/chats${query ? `?${query}` : ""}`));
}

export function listMeChatSourceCounts(params?: { engagement?: ChatEngagementView }): Promise<MeChatSourceCounts> {
  const qs = new URLSearchParams();
  if (params?.engagement) qs.set("engagement", params.engagement);
  const query = qs.toString();
  return api.get<MeChatSourceCounts>(withOrg(`/chats/source-counts${query ? `?${query}` : ""}`));
}

export function createMeChat(body: CreateMeChat): Promise<{ chatId: string }> {
  return api.post<{ chatId: string }>(withOrg("/chats"), body);
}

export function markMeChatRead(chatId: string): Promise<MeChatReadResponse> {
  return api.post<MeChatReadResponse>(`/chats/${encodeURIComponent(chatId)}/read`);
}

export function markMeChatUnread(chatId: string): Promise<MeChatUnreadResponse> {
  return api.post<MeChatUnreadResponse>(`/chats/${encodeURIComponent(chatId)}/unread`);
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
