import { type ChatEngagementView, chatEngagementViewSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { CenterPanel } from "./center/index.js";
import { OnboardingStepper } from "./center/onboarding-stepper.js";
import { ConversationList, DRAFT_CHAT_ID } from "./conversations/index.js";

/**
 * Workspace shell — chat-first. The left rail is `ConversationList`; the
 * center routes by `?c=<chatId>` (or the special `?c=draft` marker for
 * an inline new-chat draft). The conversation-list engagement tab is
 * also URL-backed via `?engagement=active|archived|all` (default active).
 *
 * Legacy URL compat:
 *   - `?a=<agentId>&c=<chatId>` redirects to `?c=<chatId>` (a is ignored).
 *   - `?a=<agentId>` (no chat) clears to `/` — agents are no longer the
 *     primary navigation key.
 */
const engagementViewParser = chatEngagementViewSchema.catch("active");

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");
  const engagement: ChatEngagementView = engagementViewParser.parse(searchParams.get("engagement"));

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
      // Preserve current engagement tab on selection — switching chats
      // shouldn't reset the user's filter context.
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const openDraft = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set("c", DRAFT_CHAT_ID);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const setEngagement = useCallback(
    (view: ChatEngagementView) => {
      const next = new URLSearchParams(searchParams);
      // Default value is omitted from the URL so the canonical home page stays `/`.
      if (view === "active") next.delete("engagement");
      else next.set("engagement", view);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList
        selectedChatId={selectedChatId}
        onSelectChat={selectChat}
        onNewChat={openDraft}
        engagement={engagement}
        onEngagementChange={setEngagement}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        {/* Stepper sits above CenterPanel only, not above the rail
            (docs/new-user-onboarding-design.md §4.1). It self-renders
            nothing when the user has dismissed onboarding. */}
        <OnboardingStepper />
        <CenterPanel selectedChatId={selectedChatId} onSelectChat={selectChat} />
      </main>
    </div>
  );
}
