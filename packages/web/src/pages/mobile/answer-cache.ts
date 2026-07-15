import type { ListMeChatsResponse, MeChatRow, Message } from "@first-tree/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

type MeChatsCache = ListMeChatsResponse | InfiniteData<ListMeChatsResponse>;

export function mobileResolvedRequestKey(chatId: string): readonly string[] {
  return ["mobile-resolved-requests", chatId];
}

export function locallyResolvedRequestIds(queryClient: QueryClient, chatId: string): ReadonlySet<string> {
  return new Set(queryClient.getQueryData<string[]>(mobileResolvedRequestKey(chatId)) ?? []);
}

/**
 * Commit the local projection of a successful mobile answer before closing the
 * sheet. The server projections are eventually consistent, so merely firing a
 * refetch leaves a window where the same cached request can be opened and sent
 * twice. A session-local request-id tombstone remains authoritative against a
 * delayed stale response, while the list/open-request caches update
 * synchronously so Now removes the resolved signal immediately.
 */
export async function commitMobileAskResolution(
  queryClient: QueryClient,
  chatId: string,
  requestId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ["chat-open-requests", chatId] }),
    queryClient.cancelQueries({ queryKey: ["me", "chats"] }),
  ]);

  queryClient.setQueryData<string[]>(mobileResolvedRequestKey(chatId), (previous = []) =>
    previous.includes(requestId) ? previous : [...previous, requestId],
  );
  queryClient.setQueryData<{ items: Message[] }>(["chat-open-requests", chatId], (previous) =>
    previous ? { ...previous, items: previous.items.filter((item) => item.id !== requestId) } : previous,
  );
  queryClient.setQueriesData<MeChatsCache>({ queryKey: ["me", "chats"] }, (previous) =>
    previous ? patchMeChatsCache(previous, chatId) : previous,
  );

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["chat-open-requests", chatId], refetchType: "none" }),
    queryClient.invalidateQueries({ queryKey: ["me", "chats"], refetchType: "none" }),
    queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] }),
  ]);
}

function patchMeChatsCache(data: MeChatsCache, chatId: string): MeChatsCache {
  if ("pages" in data) {
    return { ...data, pages: data.pages.map((page) => patchMeChatsResponse(page, chatId)) };
  }
  return patchMeChatsResponse(data, chatId);
}

function patchMeChatsResponse(data: ListMeChatsResponse, chatId: string): ListMeChatsResponse {
  const patchRow = (row: MeChatRow): MeChatRow =>
    row.chatId === chatId ? { ...row, openRequestCount: Math.max(0, row.openRequestCount - 1) } : row;

  let demoted: MeChatRow | undefined;
  const attention = data.priorityRows.attention.flatMap((row) => {
    const patched = patchRow(row);
    if (row.chatId === chatId && patched.openRequestCount === 0 && patched.failedAgentIds.length === 0) {
      demoted = patched;
      return [];
    }
    return [patched];
  });
  let pinned = data.priorityRows.pinned.map(patchRow);
  if (demoted?.pinnedAt && !pinned.some((row) => row.chatId === chatId)) pinned = [demoted, ...pinned];

  return {
    ...data,
    priorityRows: { attention, pinned },
    rows: data.rows.map(patchRow),
  };
}
