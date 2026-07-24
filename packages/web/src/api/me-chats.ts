import type {
  AddMeChatParticipants,
  ChatEngagementView,
  CreateMeChat,
  CreateWebTaskChat,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatLeaveResponse,
  MeChatPinResponse,
  MeChatReadResponse,
  MeChatSourceCounts,
  MeChatUnreadResponse,
  PinMeChat,
} from "@first-tree/shared";
import { listMeChatsResponseSchema } from "@first-tree/shared";
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
  Pick<ListMeChatsQuery, "cursor" | "limit" | "filter" | "engagement" | "origin" | "with" | "watching">
>;

export async function listMeChats(
  params?: ListMeChatsParams,
  opts?: { signal?: AbortSignal },
): Promise<ListMeChatsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.filter) qs.set("filter", params.filter);
  if (params?.engagement) qs.set("engagement", params.engagement);
  // Multi-value `origin` / `with` go on the wire as comma-joined strings.
  // The server schema's `csvArrayPreprocess` accepts both this and the
  // repeated-query-param form, but comma-joined keeps the URL compact
  // and matches the workspace UI's URL contract.
  if (params?.origin && params.origin.length > 0) qs.set("origin", params.origin.join(","));
  if (params?.with && params.with.length > 0) qs.set("with", params.with.join(","));
  if (params?.watching) qs.set("watching", "1");
  const query = qs.toString();
  // `opts.signal` lets React Query cancel the in-flight request when the
  // filter/cursor changes, so a superseded page never lands.
  //
  // Parse (not just cast): the schema's version-skew `.default`s only run when
  // something actually parses the payload. A web bundle ahead of a server that
  // predates `priorityRows` therefore reads it as the empty default rather than
  // `undefined`. Zod ignores unknown keys, so a newer server stays compatible.
  const res = await api.get<unknown>(withOrg(`/chats${query ? `?${query}` : ""}`), opts);
  return listMeChatsResponseSchema.parse(res);
}

export function listMeChatSourceCounts(
  params?: { engagement?: ChatEngagementView; watching?: boolean },
  opts?: { signal?: AbortSignal },
): Promise<MeChatSourceCounts> {
  const qs = new URLSearchParams();
  if (params?.engagement) qs.set("engagement", params.engagement);
  if (params?.watching) qs.set("watching", "1");
  const query = qs.toString();
  return api.get<MeChatSourceCounts>(withOrg(`/chats/source-counts${query ? `?${query}` : ""}`), opts);
}

export function createMeChat(body: CreateMeChat): Promise<{ chatId: string }> {
  return api.post<{ chatId: string }>(withOrg("/chats"), body);
}

export function createMeTaskChat(body: CreateWebTaskChat): Promise<{
  chatId: string;
  messageId: string;
  topic: string | null;
  effectiveSenderId: string;
  initialRecipientAgentIds: string[];
  contextParticipantAgentIds: string[];
}> {
  return api.post(withOrg("/chats"), body);
}

export function markMeChatRead(chatId: string): Promise<MeChatReadResponse> {
  return api.post<MeChatReadResponse>(`/chats/${encodeURIComponent(chatId)}/read`);
}

export function markMeChatUnread(chatId: string): Promise<MeChatUnreadResponse> {
  return api.post<MeChatUnreadResponse>(`/chats/${encodeURIComponent(chatId)}/unread`);
}

/** Pin (`pinned: true`) or unpin the chat for the current viewer (private per-user state). */
export function pinMeChat(chatId: string, pinned: boolean): Promise<MeChatPinResponse> {
  return api.post<MeChatPinResponse>(`/chats/${encodeURIComponent(chatId)}/pin`, { pinned } satisfies PinMeChat);
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
