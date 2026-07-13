import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import type { InfiniteData } from "@tanstack/react-query";

type MeChatsData = InfiniteData<ListMeChatsResponse>;

/**
 * Optimistically reflect a pin / unpin in a cached me-chats infinite list, so the
 * row jumps to (or out of) the Pinned group instantly instead of waiting for the
 * server round-trip + refetch. Pure: returns a new `InfiniteData` and never
 * mutates its input, so it doubles as the rollback source (keep the pre-call
 * value and re-set it on error).
 *
 * Mirrors the server projection contract (`shared/schemas/me-chat.ts`):
 *   - `priorityRows` (attention + pinned) lives on page 0 only; later pages carry
 *     them empty and the client reads page 0.
 *   - `attention` and `pinned` are DISJOINT and a chat already in `attention`
 *     is NOT also pinned (attention wins) — so pinning an attention chat only
 *     flips its `pinnedAt`, it does not move to the Pinned group.
 *   - `pinned` is ordered `pinnedAt` DESC, so a freshly-pinned chat prepends.
 *   - the ordinary `rows` are ADDITIVE; the row-list dedup in `index.tsx` drops
 *     any chat present in a priority group, so inserting into `pinned` removes
 *     the chat from the recency stream on the next render with no extra work.
 *
 * `pinnedAt` is flipped on EVERY occurrence of the chat (attention / pinned /
 * rows, across all pages) so the row-actions menu reads Pin vs Unpin
 * consistently wherever the chat is rendered. A chat absent from this list
 * (e.g. filtered out of another cached view) is left untouched; the trailing
 * invalidate reconciles it.
 */
export function applyOptimisticPin(data: MeChatsData, chatId: string, pinned: boolean, nowIso: string): MeChatsData {
  const nextPinnedAt = pinned ? nowIso : null;
  const setPin = (row: MeChatRow): MeChatRow =>
    row.chatId === chatId && row.pinnedAt !== nextPinnedAt ? { ...row, pinnedAt: nextPinnedAt } : row;

  // Seed row for a promotion (recency → Pinned): prefer a priority-group copy,
  // then any page's ordinary rows. Returned with a corrected `pinnedAt`.
  const findRow = (): MeChatRow | undefined => {
    for (const page of data.pages) {
      const hit =
        page.priorityRows.attention.find((r) => r.chatId === chatId) ??
        page.priorityRows.pinned.find((r) => r.chatId === chatId) ??
        page.rows.find((r) => r.chatId === chatId);
      if (hit) return hit;
    }
    return undefined;
  };

  const pages = data.pages.map((page, index) => {
    const attention = page.priorityRows.attention.map(setPin);
    let pinnedList = page.priorityRows.pinned.map(setPin);
    if (index === 0) {
      const inAttention = attention.some((r) => r.chatId === chatId);
      const inPinned = pinnedList.some((r) => r.chatId === chatId);
      if (pinned && !inAttention && !inPinned) {
        const row = findRow();
        // Newest pin first (`pinnedAt` DESC) — prepend.
        if (row) pinnedList = [{ ...row, pinnedAt: nextPinnedAt }, ...pinnedList];
      } else if (!pinned && inPinned) {
        pinnedList = pinnedList.filter((r) => r.chatId !== chatId);
      }
    }
    return { ...page, priorityRows: { attention, pinned: pinnedList }, rows: page.rows.map(setPin) };
  });

  return { ...data, pages };
}
