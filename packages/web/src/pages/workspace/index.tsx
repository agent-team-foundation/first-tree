import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { CenterPanel } from "./center/index.js";
import { ConversationList, DRAFT_CHAT_ID } from "./conversations/index.js";

/**
 * Workspace shell — chat-first. The left rail is `ConversationList`; the
 * center routes by `?c=<chatId>` (or the special `?c=draft` marker for
 * an inline new-chat draft).
 *
 * Legacy URL compat:
 *   - `?a=<agentId>&c=<chatId>` redirects to `?c=<chatId>` (a is ignored).
 *   - `?a=<agentId>` (no chat) clears to `/` — agents are no longer the
 *     primary navigation key.
 */
export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");

  useAdminWs();

  // Legacy redirects: chat-first workspace navigates by `?c=` only.
  useEffect(() => {
    if (legacyAgentId && selectedChatId) {
      // `?a=&c=` → `?c=` — drop the agent hint, keep the chat.
      setSearchParams({ c: selectedChatId }, { replace: true });
      return;
    }
    if (legacyAgentId && !selectedChatId) {
      // `?a=` alone → `/` — agents aren't navigation targets.
      setSearchParams({}, { replace: true });
    }
  }, [legacyAgentId, selectedChatId, setSearchParams]);

  const selectChat = useCallback(
    (chatId: string) => {
      setSearchParams({ c: chatId });
    },
    [setSearchParams],
  );

  const openDraft = useCallback(() => {
    setSearchParams({ c: DRAFT_CHAT_ID });
  }, [setSearchParams]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList selectedChatId={selectedChatId} onSelectChat={selectChat} onNewChat={openDraft} />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        <CenterPanel selectedChatId={selectedChatId} onSelectChat={selectChat} />
      </main>
    </div>
  );
}
