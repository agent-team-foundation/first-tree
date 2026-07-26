import type { Chat, ChatDetail, ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

type MeChatsCache = InfiniteData<ListMeChatsResponse> | ListMeChatsResponse;

function patchRows(rows: MeChatRow[], chatId: string, title: string): { rows: MeChatRow[]; changed: boolean } {
  let changed = false;
  const nextRows = rows.map((row) => {
    if (row.chatId !== chatId) return row;
    changed = true;
    return { ...row, topic: title, title };
  });
  return { rows: changed ? nextRows : rows, changed };
}

function patchResponse(data: ListMeChatsResponse, chatId: string, title: string): ListMeChatsResponse {
  const ordinary = patchRows(data.rows, chatId, title);
  const attention = patchRows(data.priorityRows.attention, chatId, title);
  const pinned = patchRows(data.priorityRows.pinned, chatId, title);
  if (!ordinary.changed && !attention.changed && !pinned.changed) return data;

  return {
    ...data,
    rows: ordinary.rows,
    priorityRows: {
      attention: attention.rows,
      pinned: pinned.rows,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isListResponse(value: unknown): value is ListMeChatsResponse {
  if (!isRecord(value) || !Array.isArray(value.rows) || !isRecord(value.priorityRows)) return false;
  return Array.isArray(value.priorityRows.attention) && Array.isArray(value.priorityRows.pinned);
}

function isMeChatsCache(value: unknown): value is MeChatsCache {
  if (isListResponse(value)) return true;
  return isRecord(value) && Array.isArray(value.pages) && value.pages.every(isListResponse);
}

function patchCache(data: MeChatsCache, chatId: string, title: string): MeChatsCache {
  if (!("pages" in data)) return patchResponse(data, chatId, title);

  let changed = false;
  const pages = data.pages.map((page) => {
    const patched = patchResponse(page, chatId, title);
    if (patched !== page) changed = true;
    return patched;
  });
  return changed ? { ...data, pages } : data;
}

/**
 * Project a successful, persisted rename into every hot conversation-list
 * cache before the follow-up refetch. Replacing rows without sorting preserves
 * server-owned ordering while touching only the matching chat id.
 *
 * Clearing a manual topic is intentionally left to the server refetch: the
 * resulting display title may fall back to the first message or participants,
 * and the client must not reimplement that resolution contract.
 */
export function applyPersistedChatRename(queryClient: QueryClient, updatedChat: Chat): void {
  const title = updatedChat.topic;
  if (!title) return;

  queryClient.setQueryData<ChatDetail>(["chat-detail", updatedChat.id], (previous) =>
    previous ? { ...previous, ...updatedChat, title } : previous,
  );

  const queries = queryClient.getQueryCache().findAll({ queryKey: ["me", "chats"] });
  for (const query of queries) {
    const previous = query.state.data;
    if (!isMeChatsCache(previous)) continue;
    const patched = patchCache(previous, updatedChat.id, title);
    if (patched !== previous) queryClient.setQueryData(query.queryKey, patched);
  }
}
