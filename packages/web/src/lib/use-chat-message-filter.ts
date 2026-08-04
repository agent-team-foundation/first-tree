import { useCallback, useState } from "react";
import { loadMessageFilter, messageFilterScope, saveMessageFilter } from "./message-filter-store.js";

type ScopedFilter = {
  scope: string;
  agentId: string | null;
};

function loadScopedFilter(scope: string): ScopedFilter {
  return { scope, agentId: loadMessageFilter(scope) };
}

/**
 * Per-chat timeline message filter, persisted per user + chat in
 * browser-local storage.
 *
 * A drop-in for `useState<string | null>(null)`: returns
 * `[filterAgentId, setFilterAgentId]`. On top of plain state it (a) seeds the
 * initial value from storage for this user + chat, (b) writes every change
 * back, and (c) swaps to the target chat's stored filter when the chat (or
 * signed-in user) changes — `ChatView` is NOT remounted on chat switch, so
 * without the swap one chat's filter would leak into the next. The swap runs
 * as a render-phase state adjustment (same pattern as `useChatDraftText`) so
 * the previous chat's filter is never exposed under the new scope.
 */
export function useChatMessageFilter(
  userId: string | null,
  chatId: string,
): [string | null, (agentId: string | null) => void] {
  const scope = messageFilterScope(userId, chatId);
  const [storedFilter, setStoredFilter] = useState<ScopedFilter>(() => loadScopedFilter(scope));
  const filter = storedFilter.scope === scope ? storedFilter : loadScopedFilter(scope);

  if (filter !== storedFilter) {
    setStoredFilter(filter);
  }

  const setFilterAgentId = useCallback(
    (agentId: string | null) => {
      saveMessageFilter(scope, agentId);
      setStoredFilter({ scope, agentId });
    },
    [scope],
  );

  return [filter.agentId, setFilterAgentId];
}
